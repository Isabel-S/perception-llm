import os, json
import pandas as pd

ROOT_DIR = "support"   # <-- confirm this is correct relative to where you run the script

SCORE_COLS = ["informational", "validation_esteem", "emotional"]

def iter_json_paths(root_dir: str):
    for root, _, files in os.walk(root_dir):
        for fn in files:
            if fn.lower().endswith(".json"):
                yield os.path.join(root, fn)

def get_category_from_folder(root_dir: str, file_path: str) -> str:
    rel = os.path.relpath(file_path, root_dir)
    return rel.split(os.sep)[0]

def load_and_flatten(root_dir: str) -> pd.DataFrame:
    json_paths = list(iter_json_paths(root_dir))
    print(f"Found {len(json_paths)} .json files under: {os.path.abspath(root_dir)}")

    rows = []
    bad_json = 0

    for path in json_paths:
        category_folder = get_category_from_folder(root_dir, path)

        try:
            with open(path, "r", encoding="utf-8") as f:
                doc = json.load(f)
        except Exception as e:
            bad_json += 1
            print(f"[BAD JSON] {path}: {e}")
            continue

        turns = doc.get("turns", [])
        if not isinstance(turns, list):
            continue

        for turn in turns:
            mm = (turn.get("mentalModel") or {}).get("mental_model", {})
            support = (mm.get("support_seeking") or {})

            rows.append({
                "file_path": path,
                "category": category_folder,
                "prompt_id": doc.get("prompt_id"),
                "turnIndex": turn.get("turnIndex"),

                # If missing, these will be None -> coerced to NaN
                "informational": (support.get("informational") or {}).get("score"),
                "validation_esteem": (support.get("validation_esteem") or {}).get("score"),
                "emotional": (support.get("emotional") or {}).get("score"),
            })

    print(f"Extracted {len(rows)} turns. Bad JSON files: {bad_json}")

    df = pd.DataFrame(rows)

    # Ensure columns exist even if rows is empty or keys missing
    for col in ["file_path", "category", "prompt_id", "turnIndex"] + SCORE_COLS:
        if col not in df.columns:
            df[col] = pd.Series(dtype="float64" if col in SCORE_COLS else "object")

    for col in SCORE_COLS:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    return df


df = load_and_flatten(ROOT_DIR)

if df.empty:
    raise RuntimeError(
        "No rows were extracted. Most likely ROOT_DIR is wrong, or JSONs don't match expected structure.\n"
        f"Check: {os.path.abspath(ROOT_DIR)}"
    )

print(df.head())
print("Categories:", sorted(df["category"].unique()))

# Save the extracted per-turn table
df.to_csv("support_scores_by_turn.csv", index=False)

# Save summary tables
score_cols = ["informational", "validation_esteem", "emotional"]

overall_avg = df[score_cols].mean().to_frame("avg_score").reset_index().rename(columns={"index":"signal"})
overall_avg.to_csv("support_scores_overall_avg.csv", index=False)

by_category_avg = (
    df.groupby("category")[score_cols].mean()
      .reset_index()
)
by_category_avg.to_csv("support_scores_by_category_avg.csv", index=False)

print("Saved:")
print(" - support_scores_by_turn.csv")
print(" - support_scores_overall_avg.csv")
print(" - support_scores_by_category_avg.csv")

score_cols = ["informational", "validation_esteem", "emotional"]

# Average per turnIndex within each category
turn_by_category = (
    df.groupby(["category", "turnIndex"])[score_cols]
      .mean()
      .reset_index()
)

print(turn_by_category.head())

import plotly.express as px

# Melt so we can color by signal
turn_long = turn_by_category.melt(
    id_vars=["category", "turnIndex"],
    value_vars=score_cols,
    var_name="signal",
    value_name="avg_score"
)

fig = px.line(
    turn_long,
    x="turnIndex",
    y="avg_score",
    color="signal",
    facet_col="category",  # one subplot per category
    title="Support-Seeking Score Trajectories by Turn and Category",
    markers=True
)

fig.update_layout(
    yaxis_title="Average Score",
    xaxis_title="Turn Index"
)

fig.show()