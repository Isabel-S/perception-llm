"""Reformat annotationFlags to user-only flattened lists.

This script is intended to post-process already-annotated mental model JSONs.
It converts the existing structure:

  "annotationFlags": { "user": {<category>: {"labels": [...]}, ...}, "assistant": {...} }

into the requested flattened list form (user-only):

  "annotationFlags": ["sycophancy-assistant-positive-affirmation", ...]

If a turn ends up with no user labels, the annotationFlags key is removed.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import List, MutableMapping, Optional, Sequence


def _load_json(path: Path) -> MutableMapping[str, object]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _write_json(path: Path, payload: MutableMapping[str, object]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def _flatten_user_flags(flags: object) -> List[str]:
    if not isinstance(flags, dict):
        return []

    user = flags.get("user")
    if not isinstance(user, dict):
        return []

    flattened: List[str] = []
    for category, details in user.items():
        if not isinstance(category, str) or not isinstance(details, dict):
            continue
        labels = details.get("labels")
        if not isinstance(labels, list):
            continue
        for label in labels:
            if isinstance(label, str) and label:
                flattened.append(f"{category}-{label}")

    # Keep deterministic ordering for diffs.
    flattened = sorted(set(flattened))
    return flattened


def reformat_file(path: Path) -> bool:
    data = _load_json(path)
    turns = data.get("turns")
    if not isinstance(turns, list):
        return False

    changed = False
    for turn in turns:
        if not isinstance(turn, dict):
            continue
        if "annotationFlags" not in turn:
            continue
        flattened = _flatten_user_flags(turn.get("annotationFlags"))
        if flattened:
            turn["annotationFlags"] = flattened
        else:
            turn.pop("annotationFlags", None)
        changed = True

    if changed:
        _write_json(path, data)
    return changed


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Reformat annotationFlags to user-only flattened lists."
    )
    parser.add_argument(
        "json_files",
        nargs="+",
        type=Path,
        help="Paths to *_with_annotations.json files to rewrite in-place.",
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    rewritten = 0
    for path in args.json_files:
        if not path.exists():
            continue
        if reformat_file(path):
            rewritten += 1
            print(f"Rewrote {path}")
    print(f"Done. Rewrote {rewritten} file(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

