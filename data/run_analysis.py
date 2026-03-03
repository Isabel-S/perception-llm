#!/usr/bin/env python3
"""
run_analysis.py — Single script for mental-model analysis, CSVs, and plots.

Outputs go to csvs_plots/ (sibling to data/), with subdirs: csvs/, plots/.

Single-call runs (API eval data under data/single_call/):
  Per run: 6 charts in one HTML (one per category), turn 0–20, one line per feature.
  CSVs: scores per turn per convo; average scores per turn per category.
  Option --combine_runs: average over all runs (seeds) for the model (and optional --api).

  Usage:
    python run_analysis.py --single_call --model induct --run run_gemini_1
    python run_analysis.py --single_call --model types_support --api gemini --combine_runs

Human runs (conversations with mental model scores, e.g. do_not_upload):
  One chart per mental model: one line per feature, score trajectory over turns.
  Error bars (SEM) and regression toggles on all charts.

  Usage:
    python run_analysis.py --human --human_dir data/do_not_upload
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go

# ---------------------------------------------------------------------------
# Paths (run from repo root; data/ and csvs_plots/ are siblings)
# ---------------------------------------------------------------------------
DATA_DIR = Path(__file__).resolve().parent
OUT_ROOT = DATA_DIR.parent / "csvs_plots"
SINGLE_CALL_DIR = DATA_DIR / "single_call"

# Mental model config
DATASET_CONFIG = {
    "induct": {
        "score_cols": [
            "validation_seeking",
            "user_rightness",
            "user_information_advantage",
            "objectivity_seeking",
        ],
        "score_group_key": "beliefs",
    },
    "types_support": {
        "score_cols": [
            "emotional_support",
            "social_companionship",
            "belonging_support",
            "information_guidance",
            "tangible_support",
        ],
        "score_group_key": "support_seeking",
    },
}

# Category order for consistent facets
CATEGORY_ORDER = [
    "exploring_ai_consciousness",
    "exploring_conspiracies",
    "intellectual_exploration",
    "mania_psychosis",
    "spiral_tropes",
    "theory_development",
]


def safe_get(d: dict, *keys: str, default=None):
    cur = d
    for k in keys:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(k)
        if cur is None:
            return default
    return cur


def extract_score_from_turn(turn: dict, group_key: str, signal: str) -> float | None:
    """Extract numeric score from turn (mentalModel.mental_model[group_key][signal].score or similar)."""
    paths = [
        ("mentalModel", "mental_model", group_key, signal, "score"),
        ("mentalModel", group_key, signal, "score"),
        ("mental_model", group_key, signal, "score"),
        (group_key, signal, "score"),
        ("mentalModel", "mental_model", group_key, signal),
        ("mentalModel", group_key, signal),
    ]
    for path in paths:
        val = safe_get(turn, *path, default=None)
        if val is None:
            continue
        if isinstance(val, dict) and "score" in val:
            val = val["score"]
        try:
            return float(val)
        except (TypeError, ValueError):
            continue
    return None


# ---------------------------------------------------------------------------
# Single-call: load all JSONs under a root (e.g. one run or many runs)
# ---------------------------------------------------------------------------
def iter_single_call_jsons(root: Path, ignore_dirs: set[str] | None = None) -> list[Path]:
    ignore_dirs = ignore_dirs or set()
    out = []
    for p in root.rglob("*.json"):
        if any(par.name in ignore_dirs for par in p.parents):
            continue
        out.append(p)
    return sorted(out)


def load_single_call_turn_table(
    root: Path,
    score_cols: list[str],
    score_group_key: str,
    run_label: str | None = None,
) -> pd.DataFrame:
    """Build dataframe: file_path, category, prompt_id, turnIndex, <score_cols>."""
    rows = []
    for path in iter_single_call_jsons(root):
        try:
            with path.open("r", encoding="utf-8") as f:
                doc = json.load(f)
        except Exception as e:
            print(f"[WARN] {path}: {e}")
            continue
        category = doc.get("category") or path.parent.name
        prompt_id = doc.get("prompt_id") or path.stem
        turns = doc.get("turns", [])
        if not isinstance(turns, list):
            continue
        for turn in turns:
            row = {
                "file_path": str(path),
                "category": category,
                "prompt_id": prompt_id,
                "turnIndex": turn.get("turnIndex"),
            }
            if run_label:
                row["run"] = run_label
            for col in score_cols:
                row[col] = extract_score_from_turn(turn, score_group_key, col)
            rows.append(row)
    return pd.DataFrame(rows)


def ensure_numeric(df: pd.DataFrame, score_cols: list[str]) -> pd.DataFrame:
    df = df.copy()
    df["turnIndex"] = pd.to_numeric(df["turnIndex"], errors="coerce")
    for c in score_cols:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


def compute_turn_stats_long(
    df: pd.DataFrame,
    score_cols: list[str],
    group_cols: list[str] | None = None,
) -> pd.DataFrame:
    """Long form: category (and optional run), turnIndex, signal, mean, std, n, sem."""
    id_vars = [c for c in ["file_path", "category", "prompt_id", "turnIndex", "run"] if c in df.columns]
    group_cols = group_cols or ["category", "turnIndex", "signal"]
    long_raw = df.melt(
        id_vars=id_vars,
        value_vars=score_cols,
        var_name="signal",
        value_name="score",
    )
    agg_cols = [c for c in ["category", "turnIndex", "signal", "run"] if c in long_raw.columns]
    agg_cols = [c for c in group_cols if c in long_raw.columns]
    if "run" in long_raw.columns and "run" not in agg_cols:
        agg_cols.append("run")
    if "category" in long_raw.columns and "category" not in agg_cols:
        agg_cols.append("category")
    if "turnIndex" not in agg_cols:
        agg_cols.append("turnIndex")
    if "signal" not in agg_cols:
        agg_cols.append("signal")
    stats = (
        long_raw.groupby(agg_cols, dropna=False)["score"]
        .agg(mean="mean", std="std", n="count")
        .reset_index()
    )
    stats["sem"] = stats["std"] / np.sqrt(stats["n"].clip(lower=1))
    return stats


def compute_regressions(stats_long: pd.DataFrame, group_by: list[str]) -> pd.DataFrame:
    """Linear regression per (group_by keys). group_by must include 'signal'."""
    rows = []
    for keys, g in stats_long.groupby(group_by, dropna=False):
        if isinstance(keys, str):
            keys = (keys,)
        key_dict = dict(zip(group_by, keys))
        gg = g.dropna(subset=["turnIndex", "mean"])
        if len(gg) < 2:
            row = {**key_dict, "slope": np.nan, "intercept": np.nan, "r2": np.nan, "n_points": len(gg)}
            rows.append(row)
            continue
        x = gg["turnIndex"].astype(float).to_numpy()
        y = gg["mean"].astype(float).to_numpy()
        slope, intercept = np.polyfit(x, y, 1)
        yhat = slope * x + intercept
        ss_res = np.sum((y - yhat) ** 2)
        ss_tot = np.sum((y - np.mean(y)) ** 2)
        r2 = 1 - (ss_res / ss_tot) if ss_tot > 0 else np.nan
        row = {**key_dict, "slope": slope, "intercept": intercept, "r2": r2, "n_points": len(gg)}
        rows.append(row)
    return pd.DataFrame(rows)


def build_figure_six_categories(
    stats_long: pd.DataFrame,
    title: str,
    categories: list[str] | None = None,
) -> go.Figure:
    """One subplot per category, one line per signal; error bars and regression toggles."""
    if categories is None:
        categories = list(pd.Series(stats_long["category"].unique()).dropna())
    # enforce order
    categories = [c for c in CATEGORY_ORDER if c in categories]
    categories += [c for c in stats_long["category"].unique() if c not in categories]
    signals = list(pd.Series(stats_long["signal"].unique()).dropna())

    fig = px.line(
        stats_long,
        x="turnIndex",
        y="mean",
        color="signal",
        facet_col="category",
        category_orders={"category": categories},
        markers=True,
        title=title,
    )
    fig.update_layout(yaxis_title="Average Score", xaxis_title="Turn Index")
    if "turnIndex" in stats_long.columns:
        fig.update_xaxes(range=[0, 20])
    fig.update_yaxes(range=[0, 1])
    # Subplot titles: show only category name (no "category=")
    for i, ann in enumerate(fig.layout.annotations):
        if hasattr(ann, "text") and "=" in ann.text:
            ann.text = ann.text.split("=", 1)[-1].strip()
        elif i < len(categories):
            ann.text = categories[i]

    # SEM error bars (default OFF)
    for tr in fig.data:
        sig = tr.name
        xaxis_id = getattr(tr, "xaxis", "x")
        col_idx = 0 if xaxis_id == "x" else (int(re.sub(r"\D", "", str(xaxis_id))) - 1)
        cat = categories[col_idx] if 0 <= col_idx < len(categories) else None
        if cat is None or sig is None:
            continue
        g = stats_long[(stats_long["category"] == cat) & (stats_long["signal"] == sig)].sort_values("turnIndex")
        if g.empty or "sem" not in g.columns:
            continue
        sem_map = dict(zip(g["turnIndex"].astype(float), g["sem"].astype(float)))
        sem_arr = [sem_map.get(float(x), None) for x in tr.x]
        tr.error_y = dict(type="data", array=sem_arr, visible=False)

    # Regression traces (default OFF)
    reg_traces_idx = []
    for ci, cat in enumerate(categories, start=1):
        for sig in signals:
            g = (
                stats_long[(stats_long["category"] == cat) & (stats_long["signal"] == sig)]
                .dropna(subset=["turnIndex", "mean"])
                .sort_values("turnIndex")
            )
            if len(g) < 2:
                continue
            x = g["turnIndex"].astype(float).to_numpy()
            y = g["mean"].astype(float).to_numpy()
            slope, intercept = np.polyfit(x, y, 1)
            x_line = np.array([max(0, np.min(x)), min(20, np.max(x))], dtype=float)
            y_line = slope * x_line + intercept
            xaxis = "x" if ci == 1 else f"x{ci}"
            yaxis = "y" if ci == 1 else f"y{ci}"
            fig.add_trace(
                go.Scatter(
                    x=x_line,
                    y=y_line,
                    mode="lines",
                    name=f"{sig} (reg)",
                    legendgroup=sig,
                    showlegend=False,
                    visible=False,
                )
            )
            fig.data[-1].xaxis = xaxis
            fig.data[-1].yaxis = yaxis
            reg_traces_idx.append(len(fig.data) - 1)

    n_traces = len(fig.data)
    mean_trace_idxs = [i for i in range(n_traces) if i not in reg_traces_idx]

    def reg_visibility(on: bool):
        vis = [True] * n_traces
        for i in reg_traces_idx:
            vis[i] = on
        return vis

    fig.update_layout(
        updatemenus=[
            dict(
                type="buttons",
                direction="left",
                x=0.0,
                y=-0.18,
                xanchor="left",
                yanchor="top",
                buttons=[
                    dict(label="Error bars: ON", method="restyle", args=[{"error_y.visible": True}, mean_trace_idxs]),
                    dict(label="Error bars: OFF", method="restyle", args=[{"error_y.visible": False}, mean_trace_idxs]),
                ],
            ),
            dict(
                type="buttons",
                direction="left",
                x=0.45,
                y=-0.18,
                xanchor="left",
                yanchor="top",
                buttons=[
                    dict(label="Regression: ON", method="update", args=[{"visible": reg_visibility(True)}]),
                    dict(label="Regression: OFF", method="update", args=[{"visible": reg_visibility(False)}]),
                ],
            ),
        ],
        margin=dict(t=80, b=100),
    )
    return fig


def build_figure_single(
    stats_long: pd.DataFrame,
    title: str,
) -> go.Figure:
    """One chart: one line per signal over turns; error bars and regression toggles."""
    for c in ["turnIndex", "mean", "sem"]:
        if c in stats_long.columns:
            stats_long[c] = pd.to_numeric(stats_long[c], errors="coerce")
    stats_long = stats_long.dropna(subset=["turnIndex", "mean"])
    signals = list(pd.Series(stats_long["signal"].unique()).dropna())

    fig = px.line(
        stats_long,
        x="turnIndex",
        y="mean",
        color="signal",
        markers=True,
        title=title,
    )
    fig.update_layout(yaxis_title="Average Score", xaxis_title="Turn Index")
    fig.update_yaxes(range=[0, 1])

    for tr in fig.data:
        sig = tr.name
        if sig is None:
            continue
        g = stats_long[stats_long["signal"] == sig].sort_values("turnIndex")
        if g.empty or "sem" not in g.columns:
            continue
        sem_map = dict(zip(g["turnIndex"].astype(float), g["sem"].astype(float)))
        sem_arr = [sem_map.get(float(x), None) for x in tr.x]
        tr.error_y = dict(type="data", array=sem_arr, visible=False)

    reg_traces_idx = []
    for sig in signals:
        g = stats_long[stats_long["signal"] == sig].dropna(subset=["turnIndex", "mean"]).sort_values("turnIndex")
        if len(g) < 2:
            continue
        x = g["turnIndex"].astype(float).to_numpy()
        y = g["mean"].astype(float).to_numpy()
        slope, intercept = np.polyfit(x, y, 1)
        x_line = np.array([np.min(x), np.max(x)], dtype=float)
        y_line = slope * x_line + intercept
        fig.add_trace(
            go.Scatter(
                x=x_line,
                y=y_line,
                mode="lines",
                name=f"{sig} (reg)",
                legendgroup=sig,
                showlegend=False,
                visible=False,
            )
        )
        reg_traces_idx.append(len(fig.data) - 1)

    n_traces = len(fig.data)
    mean_trace_idxs = [i for i in range(n_traces) if i not in reg_traces_idx]

    def reg_visibility(on: bool):
        vis = [True] * n_traces
        for i in reg_traces_idx:
            vis[i] = on
        return vis

    fig.update_layout(
        updatemenus=[
            dict(
                type="buttons",
                direction="left",
                x=0.0,
                y=-0.18,
                xanchor="left",
                yanchor="top",
                buttons=[
                    dict(label="Error bars: ON", method="restyle", args=[{"error_y.visible": True}, mean_trace_idxs]),
                    dict(label="Error bars: OFF", method="restyle", args=[{"error_y.visible": False}, mean_trace_idxs]),
                ],
            ),
            dict(
                type="buttons",
                direction="left",
                x=0.45,
                y=-0.18,
                xanchor="left",
                yanchor="top",
                buttons=[
                    dict(label="Regression: ON", method="update", args=[{"visible": reg_visibility(True)}]),
                    dict(label="Regression: OFF", method="update", args=[{"visible": reg_visibility(False)}]),
                ],
            ),
        ],
        margin=dict(t=80, b=100),
    )
    return fig


def save_csv(df: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False)
    print(f"[WROTE] {path}")


# ---------------------------------------------------------------------------
# Single-call: per run or combine_runs
# ---------------------------------------------------------------------------
def run_single_call(
    model: str,
    run_name: str | None,
    api_filter: str | None,
    combine_runs: bool,
    single_call_dir: Path,
    out_root: Path,
) -> None:
    cfg = DATASET_CONFIG.get(model)
    if not cfg:
        raise SystemExit(f"Unknown model: {model}. Use one of: {list(DATASET_CONFIG)}")
    score_cols = cfg["score_cols"]
    score_group_key = cfg["score_group_key"]

    model_dir = single_call_dir / model
    if not model_dir.exists():
        raise SystemExit(f"Not found: {model_dir}")

    run_dirs = sorted([d for d in model_dir.iterdir() if d.is_dir() and d.name.startswith("run_")])
    if api_filter:
        run_dirs = [d for d in run_dirs if api_filter.lower() in d.name.lower()]
    if run_name:
        run_dirs = [d for d in run_dirs if d.name == run_name]
    if not run_dirs:
        raise SystemExit(f"No run dirs found under {model_dir} (run={run_name}, api={api_filter})")

    if combine_runs:
        # Aggregate all selected runs
        all_dfs = []
        for r in run_dirs:
            df = load_single_call_turn_table(r, score_cols, score_group_key, run_label=r.name)
            if not df.empty:
                all_dfs.append(df)
        if not all_dfs:
            raise SystemExit("No data loaded from any run.")
        df = pd.concat(all_dfs, ignore_index=True)
        df = ensure_numeric(df, score_cols)
        slug = f"{model}_combined"
        if api_filter:
            slug += f"_{api_filter}"
        csv_dir = out_root / "csvs" / "single_call" / slug
        plot_dir = out_root / "plots" / "single_call"
        plot_dir.mkdir(parents=True, exist_ok=True)
        # Scores per turn per convo
        save_csv(df, csv_dir / "scores_per_turn_per_convo.csv")
        # Stats long (mean/sem per category, turnIndex, signal) — average across runs then across convos
        stats_long = compute_turn_stats_long(df, score_cols, group_cols=["category", "turnIndex", "signal"])
        save_csv(stats_long, csv_dir / "avg_scores_per_turn_per_category.csv")
        regs = compute_regressions(stats_long, ["category", "signal"])
        save_csv(regs, csv_dir / "regression_per_category.csv")
        fig = build_figure_six_categories(
            stats_long,
            title=f"{model} (combined runs: {', '.join(d.name for d in run_dirs)})",
        )
        fig.write_html(plot_dir / f"{slug}.html", include_plotlyjs="cdn")
        print(f"[WROTE] {plot_dir / f'{slug}.html'}")
        return

    # Per run
    for run_dir in run_dirs:
        df = load_single_call_turn_table(run_dir, score_cols, score_group_key, run_label=run_dir.name)
        if df.empty:
            print(f"[SKIP] no data: {run_dir}")
            continue
        df = ensure_numeric(df, score_cols)
        slug = f"{model}_{run_dir.name}"
        csv_dir = out_root / "csvs" / "single_call" / slug
        plot_dir = out_root / "plots" / "single_call"
        plot_dir.mkdir(parents=True, exist_ok=True)
        save_csv(df, csv_dir / "scores_per_turn_per_convo.csv")
        stats_long = compute_turn_stats_long(df, score_cols, group_cols=["category", "turnIndex", "signal"])
        save_csv(stats_long, csv_dir / "avg_scores_per_turn_per_category.csv")
        regs = compute_regressions(stats_long, ["category", "signal"])
        save_csv(regs, csv_dir / "regression_per_category.csv")
        fig = build_figure_six_categories(
            stats_long,
            title=f"{model} — {run_dir.name}",
        )
        fig.write_html(plot_dir / f"{slug}.html", include_plotlyjs="cdn")
        print(f"[WROTE] {plot_dir / f'{slug}.html'}")


# ---------------------------------------------------------------------------
# Human runs: find *_induct.json / *_types_support.json, one chart per model
# ---------------------------------------------------------------------------
def infer_human_model_from_path(path: Path) -> str | None:
    """Return 'induct' or 'types_support' from filename, else None."""
    stem = path.stem.lower()
    if "_induct" in stem or stem.endswith("induct"):
        return "induct"
    if "_types_support" in stem or "_support_2" in stem or "types_support" in stem:
        return "types_support"
    return None


def iter_human_jsons(root: Path) -> list[tuple[Path, str]]:
    """Yield (path, model) where model is 'induct' or 'types_support'."""
    out = []
    for p in root.rglob("*.json"):
        model = infer_human_model_from_path(p)
        if model:
            out.append((p, model))
    return out


def load_human_doc(path: Path, group_key: str, score_cols: list[str]) -> list[dict]:
    with path.open("r", encoding="utf-8") as f:
        doc = json.load(f)
    meta = doc.get("meta", {}) or {}
    source_id = meta.get("sourceId") or meta.get("source") or path.stem
    turns = doc.get("turns", [])
    if not isinstance(turns, list):
        return []
    rows = []
    for turn in turns:
        if not isinstance(turn, dict):
            continue
        row = {
            "file_path": str(path),
            "sourceId": source_id,
            "turnIndex": turn.get("turnIndex"),
        }
        for col in score_cols:
            row[col] = extract_score_from_turn(turn, group_key, col)
        rows.append(row)
    return rows


def human_files_slug(paths: list[Path], max_join: int = 3) -> str:
    """Build a filesystem-safe slug from the given paths (stems)."""
    if not paths:
        return "human"
    if len(paths) == 1:
        return paths[0].stem
    if len(paths) <= max_join:
        return "_and_".join(p.stem for p in paths)
    return f"{paths[0].stem}_plus_{len(paths) - 1}_others"


def run_human(
    human_dir: Path,
    out_root: Path,
    models: list[str] | None = None,
    human_files: list[str] | None = None,
) -> None:
    if not human_dir.exists():
        raise SystemExit(f"Human dir not found: {human_dir}")
    human_dir = human_dir.resolve()

    if human_files:
        # Use only the specified paths (relative to human_dir or absolute)
        pairs: list[tuple[Path, str]] = []
        for raw in human_files:
            p = Path(raw)
            if not p.is_absolute():
                p = human_dir / p
            else:
                p = p.resolve()
            if not p.exists():
                print(f"[WARN] Not found: {p}")
                continue
            model = infer_human_model_from_path(p)
            if not model:
                print(f"[WARN] Cannot infer model (induct/types_support) from filename: {p.name}")
                continue
            pairs.append((p, model))
        if not pairs:
            raise SystemExit("No valid --human_files paths found.")
    else:
        pairs = iter_human_jsons(human_dir)

    if models:
        pairs = [(p, m) for p, m in pairs if m in models]
    by_model: dict[str, list[Path]] = {}
    for path, model in pairs:
        by_model.setdefault(model, []).append(path)
    if not by_model:
        print("[WARN] No human JSON files to plot (none found or none matched --human_files/--model).")
        return

    csv_dir_base = out_root / "csvs" / "human"
    plot_dir = out_root / "plots" / "human"
    plot_dir.mkdir(parents=True, exist_ok=True)

    for model, paths in by_model.items():
        cfg = DATASET_CONFIG.get(model)
        if not cfg:
            continue
        score_cols = cfg["score_cols"]
        score_group_key = cfg["score_group_key"]
        all_rows = []
        for p in paths:
            try:
                all_rows.extend(load_human_doc(p, score_group_key, score_cols))
            except Exception as e:
                print(f"[WARN] {p}: {e}")
        if not all_rows:
            continue
        df = pd.DataFrame(all_rows)
        df = ensure_numeric(df, score_cols)
        # Name outputs after the file(s): e.g. h01_gemini_induct, or h01_gemini_induct_and_h05_1_gemini_induct
        slug = human_files_slug(paths)
        csv_dir = csv_dir_base / slug
        save_csv(df, csv_dir / "scores_per_turn_per_convo.csv")
        # Aggregate over convos: mean/sem per turn per signal
        id_vars = [c for c in ["file_path", "sourceId", "turnIndex"] if c in df.columns]
        long_raw = df.melt(
            id_vars=id_vars,
            value_vars=score_cols,
            var_name="signal",
            value_name="score",
        )
        stats = (
            long_raw.groupby(["turnIndex", "signal"], dropna=False)["score"]
            .agg(mean="mean", std="std", n="count")
            .reset_index()
        )
        stats["sem"] = stats["std"] / np.sqrt(stats["n"].clip(lower=1))
        save_csv(stats, csv_dir / "avg_scores_per_turn.csv")
        regs = compute_regressions(stats, ["signal"])
        save_csv(regs, csv_dir / "regression.csv")
        fig = build_figure_single(
            stats,
            title=f"Human — {slug} ({model})",
        )
        fig.write_html(plot_dir / f"{slug}.html", include_plotlyjs="cdn")
        print(f"[WROTE] {plot_dir / f'{slug}.html'}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run mental-model analysis: single_call (API runs) and/or human runs.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--single_call", action="store_true", help="Analyze single_call API runs")
    parser.add_argument("--human", action="store_true", help="Analyze human-run JSONs")
    parser.add_argument(
        "--model",
        choices=list(DATASET_CONFIG),
        default=None,
        help="Mental model: induct or types_support (single_call only)",
    )
    parser.add_argument(
        "--run",
        default=None,
        help="Run folder name, e.g. run_gemini_1 (single_call only; omit for combine_runs)",
    )
    parser.add_argument(
        "--api",
        default=None,
        help="Filter runs by API name, e.g. gemini (single_call only)",
    )
    parser.add_argument(
        "--combine_runs",
        action="store_true",
        help="Average over all matching runs (single_call only)",
    )
    parser.add_argument(
        "--single_call_dir",
        type=Path,
        default=SINGLE_CALL_DIR,
        help=f"Root for single_call data (default: {SINGLE_CALL_DIR})",
    )
    parser.add_argument(
        "--human_dir",
        type=Path,
        default=DATA_DIR / "do_not_upload",
        help="Root for human JSONs (default: data/do_not_upload)",
    )
    parser.add_argument(
        "--human_files",
        nargs="+",
        default=None,
        metavar="PATH",
        help="Specific JSON file(s) to graph, relative to --human_dir (e.g. h01/h01_gemini_induct.json). If omitted, all *_induct.json and *_types_support.json under --human_dir are used.",
    )
    parser.add_argument(
        "--out_dir",
        type=Path,
        default=OUT_ROOT,
        help=f"Output root for csvs and plots (default: {OUT_ROOT})",
    )
    args = parser.parse_args()

    if not args.single_call and not args.human:
        parser.error("Use at least one of --single_call or --human")

    out_root = args.out_dir.resolve()
    out_root.mkdir(parents=True, exist_ok=True)

    if args.single_call:
        if not args.model:
            parser.error("--single_call requires --model (induct or types_support)")
        run_single_call(
            model=args.model,
            run_name=args.run,
            api_filter=args.api,
            combine_runs=args.combine_runs,
            single_call_dir=args.single_call_dir,
            out_root=out_root,
        )

    if args.human:
        run_human(
            human_dir=args.human_dir,
            out_root=out_root,
            models=args.model and [args.model] or None,
            human_files=args.human_files,
        )

    print("[DONE] run_analysis.py")


if __name__ == "__main__":
    main()
