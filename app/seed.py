"""Synthetic demo data. Realistic shape, zero real records.

This runs on first boot so the app has something to render. Every value here is
generated from a fixed seed, so the demo is byte-identical on every machine and
contains nothing that came from a real system.
"""

from __future__ import annotations

import argparse
import random
from pathlib import Path

SEED = 20240101
PRODUCTS = [
    ("Espresso Blend 1kg", "Beverages", 14.50),
    ("Oat Milk 1L", "Dairy", 3.20),
    ("Sourdough Loaf", "Bakery", 4.80),
    ("Free-Range Eggs (12)", "Dairy", 5.10),
    ("Cold Brew Concentrate", "Beverages", 11.00),
    ("Dark Chocolate 70%", "Snacks", 2.75),
    ("Sparkling Water 6pk", "Beverages", 6.40),
    ("Pasta Rigatoni 500g", "Dry goods", 2.10),
]
REGIONS = ["north", "south", "east", "west", "central"]


def generate(n_items: int = 240) -> list[dict]:
    rng = random.Random(SEED)
    rows = []
    for i in range(n_items):
        name, category, unit = rng.choice(PRODUCTS)
        qty = rng.randint(0, 180)
        rows.append({
            "id": i + 1,
            "sku": f"SKU-{1000 + i}",
            "name": name,
            "category": category,
            "region": rng.choice(REGIONS),
            "quantity": qty,
            "unit_price": unit,
            "stock_value": round(qty * unit, 2),
        })
    return rows


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--if-empty", action="store_true",
                    help="only write when the target does not already exist")
    ap.add_argument("--out", default="data/demo.json")
    args = ap.parse_args()

    out = Path(args.out)
    if args.if_empty and out.exists():
        print(f"demo data already present at {out}, leaving it alone")
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    import json
    out.write_text(json.dumps(generate(), indent=2), encoding="utf-8")
    print(f"wrote {len(generate())} synthetic rows to {out}")


if __name__ == "__main__":
    main()
