"""Annotate mental model JSONs with sycophancy/positivity/delusion flags.

This script joins the per-message annotation parquet used elsewhere in this
repo to the per-turn mental model JSONs produced for human-line transcripts.

Usage (from repo root):

  python scripts/annotate_mental_models_with_annotations.py \\
      data/do_not_upload/hl15_chat170/hl15_chat170_gpt-4o_induct.json \\
      data/do_not_upload/hl15_chat212/hl15_chat212_gpt-4o_induct.json \\
      data/do_not_upload/hl16_chat35/hl16_chat35_gpt-4o_induct.json \\
      data/do_not_upload/hl03_chat0/hl03_chat0_gpt-4o_induct.json

By default this:
* loads ``llm-delusions-main/annotations/all_annotations__preprocessed.parquet``
* for each JSON:
  - infers the participant id from ``meta.sourceId`` (e.g. ``hl15`` -> ``hl_15``)
  - filters annotations for that participant and ``meta.chat_index``
  - assumes messages alternate user/assistant so that:
        user message index      = turnIndex * 2
        assistant message index = turnIndex * 2 + 1
  - attaches, for each turn, an ``annotationFlags`` block that indicates
    which messages were positive (score >= cutoff) for:
        - sycophancy (bundle)
        - pos_affirmation (single label)
        - delusional (bundle)
    including which underlying label ids fired.

The script writes side-by-side copies named
``<original_stem>_with_annotations.json`` in the same directory.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, MutableMapping, Optional, Sequence, Tuple

import pandas as pd


# Annotation ids, aligned with scripts/rank_chats_by_annotation_pct.py
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


AnnotationFlags = Dict[str, Dict[str, object]]


@dataclass(frozen=True)
class CategoryConfig:
    """Configuration for an annotation bundle."""

    name: str
    ids: Tuple[str, ...]


CATEGORIES: Tuple[CategoryConfig, ...] = (
    CategoryConfig("sycophancy", tuple(SYCOPHANCY_IDS)),
    CategoryConfig("pos_affirmation", tuple(POS_AFFIRMATION_IDS)),
    CategoryConfig("delusional", tuple(DELUSIONAL_IDS)),
)


def _infer_participant(source_id: str) -> str:
    """Infer participant id used in parquet from a mental-model ``sourceId``.

    For human-line participants we normalise ``hl15`` -> ``hl_15``.
    If the id already contains an underscore it is returned as-is.
    """

    if "_" in source_id:
        return source_id
    if source_id.startswith("hl") and source_id[2:].isdigit():
        return f"hl_{source_id[2:]}"
    return source_id


def _build_annotation_lookup(
    table_path: Path,
    cutoff: int,
    participants: Iterable[str],
    chat_indices: Iterable[int],
) -> Mapping[Tuple[str, int, int], AnnotationFlags]:
    """Load parquet and build a lookup keyed by (participant, chat_index, message_index).

    Each value is a nested mapping of the form::

        {
            \"sycophancy\": {\"any\": True, \"labels\": [\"assistant-positive-affirmation\", ...]},
            \"pos_affirmation\": {...},
            \"delusional\": {...},
        }
    """

    participants = {str(p) for p in participants}
    chat_indices = {int(ci) for ci in chat_indices}

    if not participants or not chat_indices:
        return {}

    if not table_path.exists():
        raise SystemExit(f"Annotations parquet not found at {table_path}")

    # Load full table, then select the score columns that actually exist.
    df = pd.read_parquet(table_path, engine="pyarrow")

    base_cols = ["participant", "source_path", "chat_index", "message_index", "role"]
    for col in base_cols:
        if col not in df.columns:
            raise SystemExit(f"Annotations parquet missing required column: {col}")

    available_score_cols = {c for c in df.columns if c.startswith("score__")}

    df = df[base_cols + sorted(available_score_cols)]
    df = df[df["participant"].astype(str).isin(participants)]
    df = df[df["chat_index"].astype(int).isin(chat_indices)]
    if df.empty:
        return {}

    lookup: Dict[Tuple[str, int, int], AnnotationFlags] = {}

    for _, row in df.iterrows():
        key = (str(row["participant"]), int(row["chat_index"]), int(row["message_index"]))
        flags: AnnotationFlags = lookup.setdefault(key, {})

        for cfg in CATEGORIES:
            labels: List[str] = []
            for aid in cfg.ids:
                col = f"score__{aid}"
                if col not in available_score_cols:
                    continue
                score = row.get(col)
                try:
                    is_positive = score is not None and float(score) >= float(cutoff)
                except (TypeError, ValueError):
                    is_positive = False
                if is_positive:
                    labels.append(aid)

            if labels:
                flags[cfg.name] = {"any": True, "labels": labels}

    return lookup


def _annotate_turns(
    turns: List[MutableMapping[str, object]],
    participant: str,
    chat_index: int,
    lookup: Mapping[Tuple[str, int, int], AnnotationFlags],
) -> None:
    """Attach annotation flags in-place to each turn.

    Adds a new key ``annotationFlags`` of the form::

        {
            \"user\": {...},        # may be empty if no positive labels
            \"assistant\": {...},   # same
        }
    """

    for turn in turns:
        turn_index = int(turn.get("turnIndex", 0))
        user_idx = turn_index * 2
        assistant_idx = turn_index * 2 + 1

        user_flags = lookup.get((participant, chat_index, user_idx), {})
        assistant_flags = lookup.get((participant, chat_index, assistant_idx), {})

        # Only attach block if there is something to say, to avoid bloating JSON.
        if user_flags or assistant_flags:
            turn["annotationFlags"] = {
                "user": user_flags,
                "assistant": assistant_flags,
            }


def _load_json(path: Path) -> MutableMapping[str, object]:
    """Load a UTF-8 JSON file."""

    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _write_json(path: Path, payload: Mapping[str, object]) -> None:
    """Write a UTF-8 JSON file with pretty indentation."""

    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")


def _collect_meta_from_files(files: Sequence[Path]) -> Tuple[List[str], List[int]]:
    """First pass over JSON files to gather participant ids and chat indices."""

    participants: List[str] = []
    chat_indices: List[int] = []

    for path in files:
        data = _load_json(path)
        meta = data.get("meta") or {}
        source_id = str(meta.get("sourceId", "")).strip()
        chat_index = int(meta.get("chat_index", 0))
        participant = _infer_participant(source_id)
        participants.append(participant)
        chat_indices.append(chat_index)

    return participants, chat_indices


def annotate_files(
    json_paths: Sequence[Path],
    parquet_path: Path,
    cutoff: int,
) -> None:
    """Annotate one or more mental model JSON files in-place copies."""

    json_paths = [p for p in json_paths if p.exists()]
    if not json_paths:
        raise SystemExit("No existing JSON files to annotate.")

    participants, chat_indices = _collect_meta_from_files(json_paths)
    lookup = _build_annotation_lookup(parquet_path, cutoff, participants, chat_indices)

    if not lookup:
        print("Warning: no matching annotations found for requested files.")

    for path in json_paths:
        data = _load_json(path)
        meta = data.get("meta") or {}
        source_id = str(meta.get("sourceId", "")).strip()
        chat_index = int(meta.get("chat_index", 0))
        participant = _infer_participant(source_id)

        turns = data.get("turns")
        if not isinstance(turns, list):
            print(f"Skipping {path}: no 'turns' array found.")
            continue

        _annotate_turns(turns, participant, chat_index, lookup)

        out_path = path.with_name(f"{path.stem}_with_annotations.json")
        # Record some provenance in meta.
        meta.setdefault("annotation_join", {})
        meta["annotation_join"].update(
            {
                "parquet": str(parquet_path),
                "cutoff": cutoff,
            }
        )
        data["meta"] = meta

        _write_json(out_path, data)
        print(f"Wrote {out_path}")


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    """Parse command-line arguments."""

    parser = argparse.ArgumentParser(
        description="Annotate mental model JSON files with sycophancy/positivity/delusional flags.",
    )
    parser.add_argument(
        "json_files",
        nargs="+",
        type=Path,
        help="Paths to mental model JSON files to annotate.",
    )
    parser.add_argument(
        "--parquet",
        type=Path,
        default=Path("llm-delusions-main/annotations/all_annotations__preprocessed.parquet"),
        help="Path to preprocessed annotations parquet (default: %(default)s).",
    )
    parser.add_argument(
        "--cutoff",
        type=int,
        default=8,
        help="Score threshold for positive label (default: %(default)s).",
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Script entry point."""

    args = parse_args(argv)
    annotate_files(args.json_files, args.parquet, args.cutoff)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

