#!/usr/bin/env python3
"""Compila il menù Trattoria Blanch da food.json e wines.tsv.

Uso: python3 blanch/tools/build_menu.py, dalla root del repository oppure da qualsiasi cwd.
Modificare solo i dati verificati nelle due fonti; questo script elimina le note editoriali
prima della pubblicazione e conserva nomi/valori a cui il cliente ha dato riscontro.
"""
from __future__ import annotations

import csv
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
LANGS = ("it", "en", "de")
CATEGORIES = {
    "Vini Bianchi": {"it": "Vini bianchi", "en": "White wines", "de": "Weißweine"},
    "Vini Rossi": {"it": "Vini rossi", "en": "Red wines", "de": "Rotweine"},
    "Vini Dolci": {"it": "Vini dolci", "en": "Dessert wines", "de": "Dessertweine"},
    "Vini Spumanti": {"it": "Vini spumanti", "en": "Sparkling wines", "de": "Schaumweine"},
}


def clean_item(item: dict) -> dict:
    return {key: value for key, value in item.items() if key not in ("source", "editorial_note")}


def validate_localized(value: dict | str, where: str) -> None:
    if isinstance(value, str):
        if not value.strip():
            raise ValueError(f"Empty string at {where}")
    elif not isinstance(value, dict) or not all(isinstance(value.get(lang), str) and value[lang].strip() for lang in LANGS):
        raise ValueError(f"Missing IT/EN/DE at {where}")


def main() -> None:
    source = json.loads((DATA / "food.json").read_text(encoding="utf-8"))
    if set(source) != {"food", "notes"}:
        raise ValueError("Expected food and notes in food.json")
    if not source["food"] or not all(source["notes"].get(k) for k in ("food", "wine")):
        raise ValueError("Food and safety notes cannot be empty")
    food = []
    for section in source["food"]:
        validate_localized(section["title"], "food section title")
        items = []
        for item in section["items"]:
            validate_localized(item["name"], "food item name")
            if "description" in item:
                validate_localized(item["description"], "food description")
            if "variants" in item:
                if not item["variants"] or "price" in item:
                    raise ValueError("Variants require prices and cannot be combined with item price")
                for v in item["variants"]:
                    validate_localized(v["label"], "variant label")
                    if not v.get("price", "").startswith("€ "):
                        raise ValueError("Invalid variant price")
            elif not item.get("price", "").startswith("€ "):
                raise ValueError("Food item missing price")
            items.append(clean_item(item))
        section_clean = {k: v for k, v in section.items() if k != "items"}
        food.append({**section_clean, "items": items})
    wines = {key: {"title": names, "items": []} for key, names in CATEGORIES.items()}
    with (DATA / "wines.tsv").open(encoding="utf-8", newline="") as source_file:
        reader = csv.DictReader(source_file, delimiter="\t")
        expected = {"category", "producer", "location", "name", "details", "price", "source"}
        if set(reader.fieldnames or []) != expected:
            raise ValueError("Unexpected wines.tsv columns")
        for number, row in enumerate(reader, 2):
            if row["category"] not in wines:
                raise ValueError(f"Unknown wine category on row {number}")
            if not row["name"].strip() or not row["producer"].strip():
                raise ValueError(f"Missing wine/producer on row {number}")
            if len(row["price"].split(",")) != 2:
                raise ValueError(f"Unexpected price on row {number}")
            producer = row["producer"] + (" · " + row["location"] if row["location"] else "")
            item = {"name": row["name"], "producer": producer, "price": "€ " + row["price"]}
            if row["details"]:
                item["detail"] = row["details"]
            wines[row["category"]]["items"].append(item)
    if not all(section["items"] for section in wines.values()):
        raise ValueError("All four wine sections must have entries")
    result = {"name": "Trattoria Blanch", "languages": list(LANGS), "food": food, "wine": list(wines.values()), "notes": source["notes"]}
    output = DATA / "menu.json"
    output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    count = Counter({"food": sum(len(s["items"]) for s in food), "wine": sum(len(s["items"]) for s in wines.values())})
    print(f"Wrote {output}: {count['food']} food/drink entries, {count['wine']} bottled wines")


if __name__ == "__main__":
    main()
