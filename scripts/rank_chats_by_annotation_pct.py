#!/usr/bin/env python3
"""
Rank conversations by the fraction of messages that are positive for a given
annotation category. Use this to find chats with the highest % of sycophancy,
positive affirmation, or delusional content.

Usage (from repo root):

  # Sycophancy (bundle of 6 annotations) — top 30 chats, min 50 messages
  python scripts/rank_chats_by_annotation_pct.py --category sycophancy -n 30 -m 50

  # Positive affirmation only (single annotation)
  python scripts/rank_chats_by_annotation_pct.py --category pos_affirmation -n 30 -m 50

  # Delusional (bundle of delusional annotations)
  python scripts/rank_chats_by_annotation_pct.py --category delusional -n 30 -m 50

Requires: pandas, pyarrow. Parquet path is relative to repo root.
"""

from __future__ import annotations

import argparse
from pathlib import Path

# Annotation set ids, aligned to the actual score__ column suffixes in
# all_annotations__preprocessed.parquet for this repo snapshot.
SYCOPHANCY_IDS = [
    "assistant-reflective-summary",
    "assistant-positive-affirmation",
    "assistant-dismisses-counterevidence",
    "assistant-reports-others-admire-speaker",
    "grand-significance",
    "assistant-claims-unique-connection",
]
POS_AFFIRMATION_IDS = ["assistant-positive-affirmation"]
DELUSIONAL_IDS = [
    "assistant-misrepresents-ability",
    "user-misconstrues-sentience",
    "assistant-misrepresents-sentience",
    "user-metaphysical-themes",
    "assistant-metaphysical-themes",
    "user-endorses-delusion",
    "assistant-endorses-delusion",
    "user-assigns-personhood",
]

CATEGORIES = {
    "sycophancy": SYCOPHANCY_IDS,
    "pos_affirmation": POS_AFFIRMATION_IDS,
    "delusional": DELUSIONAL_IDS,
}

# Message is "positive" if score >= this (common LLM cutoff)
DEFAULT_CUTOFF = 8


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Rank chats by %% of messages positive for an annotation category."
    )
    parser.add_argument(
        "--category",
        choices=list(CATEGORIES.keys()),
        required=True,
        help="Category: sycophancy, pos_affirmation, or delusional",
    )
    parser.add_argument(
        "-n",
        "--top",
        type=int,
        default=30,
        help="Number of top chats to print (default 30)",
    )
    parser.add_argument(
        "-m",
        "--min-messages",
        type=int,
        default=50,
        help="Minimum messages per chat to include (default 50)",
    )
    parser.add_argument(
        "--parquet",
        type=Path,
        default=Path("llm-delusions-main/annotations/all_annotations__preprocessed.parquet"),
        help="Path to preprocessed annotations parquet",
    )
    parser.add_argument(
        "--cutoff",
        type=int,
        default=DEFAULT_CUTOFF,
        help="Score threshold for positive (default %s)" % DEFAULT_CUTOFF,
    )
    args = parser.parse_args()

    import pandas as pd

    path = args.parquet
    if not path.exists():
        raise SystemExit("Parquet not found: %s" % path)

    df = pd.read_parquet(path, engine="pyarrow")
    score_cols = [c for c in df.columns if c.startswith("score__")]
    annotation_ids = CATEGORIES[args.category]
    # Use only score columns that exist
    cols = ["score__%s" % aid for aid in annotation_ids if "score__%s" % aid in score_cols]
    if not cols:
        raise SystemExit(
            "None of the category columns found in parquet. Available score__ columns: %s"
            % ([c for c in score_cols][:20])
        )

    key = ["participant", "source_path", "chat_index"]
    if not all(k in df.columns for k in key):
        raise SystemExit("Parquet missing key columns: %s" % key)

    # Per message: positive if any of the category scores >= cutoff
    df = df.copy()
    df["_pos"] = (df[cols] >= args.cutoff).any(axis=1).astype(int)
    agg = df.groupby(key, as_index=False).agg(
        n_messages=("_pos", "count"),
        n_positive=("_pos", "sum"),
    )
    agg = agg[agg["n_messages"] >= args.min_messages]
    agg["pct"] = (agg["n_positive"] / agg["n_messages"] * 100).round(2)
    agg = agg.sort_values("pct", ascending=False).head(args.top)

    print("Category: %s (cutoff >= %s, min_messages=%s)" % (args.category, args.cutoff, args.min_messages))
    print("Columns used: %s" % cols)
    print("-" * 80)
    for _, row in agg.iterrows():
        print(
            "  %s  chat_index=%s  pct=%.1f%%  (%s / %s messages)"
            % (
                row["participant"],
                row["chat_index"],
                row["pct"],
                int(row["n_positive"]),
                int(row["n_messages"]),
            )
        )


if __name__ == "__main__":
    main()
