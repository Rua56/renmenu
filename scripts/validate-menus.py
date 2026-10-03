#!/usr/bin/env python3
"""Controlla i file JSON pubblicati in menus/ senza modificarli.

Uso: python3 scripts/validate-menus.py
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections.abc import Mapping
from pathlib import Path
from urllib.parse import urlparse

ALLOWED_ALLERGENS = {str(number) for number in range(1, 15)}
ALLOWED_THEMES = {"bordeaux", "trattoria", "mare", "terracotta", "notte", "sole"}
ALLOWED_TAGS = {"veg", "vegan", "spicy", "gf", "new", "top", "frozen"}
LEGACY_SUPPORTED_TAGS = {"hot", "riserva"}
SUPPORTED_UI_LANGUAGES = {"it", "en", "de", "fr", "es"}
PREMIUM_DIRECTIONS = {"editoriale", "bistrot", "moderno"}
PREMIUM_FONTS = {"classico", "moderno", "artigianale"}
PREMIUM_COLORS = {"fondo", "testo", "accento", "secondario"}
PREMIUM_KEYS = {"direzione", "caratteri", "colori", "logo", "copertina", "motto", "storia"}
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
IMAGE_PATH = re.compile(r"^(?:\.\./|/)?[A-Za-z0-9_./-]+\.(?:webp|png|jpe?g|svg|avif)$", re.IGNORECASE)
PRICE_PATTERN = re.compile(r"^\d+(?:[,.]\d{1,2})?$")
INSTAGRAM_PATTERN = re.compile(r"^@?[A-Za-z0-9._]{1,30}$")
PHONE_DIGITS_PATTERN = re.compile(r"\D+")


class Report:
    def __init__(self) -> None:
        self.errors = 0
        self.warnings = 0
        self.files = 0
        self.current_file = ""
        self.empty_prices: list[str] = []
        self.legacy_tags: dict[str, list[str]] = {}

    def start_file(self, path: Path) -> None:
        self.files += 1
        self.current_file = path.name
        self.empty_prices = []
        self.legacy_tags = {}
        print(f"\n[{path.name}]")

    def error(self, message: str) -> None:
        self.errors += 1
        print(f"  ERRORE: {message}")

    def warning(self, message: str) -> None:
        self.warnings += 1
        print(f"  Avviso: {message}")

    def ok(self) -> None:
        print("  OK")

    def record_empty_price(self, label: str) -> None:
        self.empty_prices.append(label)

    def record_legacy_tag(self, tag: str, label: str) -> None:
        self.legacy_tags.setdefault(tag, []).append(label)

    def flush_compatibility_warnings(self) -> None:
        if self.empty_prices:
            examples = ", ".join(self.empty_prices[:3])
            suffix = "…" if len(self.empty_prices) > 3 else ""
            self.warning(
                f"{len(self.empty_prices)} voci hanno un prezzo vuoto e non mostreranno alcun importo "
                f"(esempi: {examples}{suffix})."
            )
        for tag, labels in sorted(self.legacy_tags.items()):
            examples = ", ".join(labels[:3])
            suffix = "…" if len(labels) > 3 else ""
            self.warning(
                f"tag legacy '{tag}' mantenuto in {len(labels)} voci per compatibilità; non usarlo nei nuovi menù "
                f"(esempi: {examples}{suffix})."
            )


def non_empty_text(value: object) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, Mapping):
        return any(isinstance(text, str) and text.strip() for text in value.values())
    return False


def localized_text(value: object, language: str) -> bool:
    return isinstance(value, Mapping) and isinstance(value.get(language), str) and bool(value[language].strip())


def validate_price(value: object, label: str, report: Report) -> None:
    if isinstance(value, bool):
        report.error(f"{label}: il prezzo deve essere un numero o testo numerico, non un booleano.")
        return
    if isinstance(value, (int, float)):
        if not math.isfinite(value) or value <= 0:
            report.error(f"{label}: il prezzo deve essere maggiore di zero.")
        return
    if not isinstance(value, str):
        report.error(f"{label}: il prezzo deve essere un numero o una stringa numerica.")
        return
    normalized = value.strip()
    if not normalized:
        report.record_empty_price(label)
        return
    if not PRICE_PATTERN.fullmatch(normalized):
        report.error(f"{label}: prezzo '{value}' non valido. Usa ad esempio 12 oppure 12,50.")
        return
    if float(normalized.replace(",", ".")) <= 0:
        report.error(f"{label}: il prezzo deve essere maggiore di zero.")


def validate_allergens(value: object, label: str, report: Report) -> None:
    if not isinstance(value, list):
        report.error(f"{label}: allergeni deve essere una lista di valori da 1 a 14.")
        return
    normalized: list[str] = []
    for allergen in value:
        if isinstance(allergen, bool):
            report.error(f"{label}: allergene '{allergen}' non valido.")
            continue
        key = str(allergen).strip()
        if key not in ALLOWED_ALLERGENS:
            report.error(f"{label}: allergene '{allergen}' non ammesso (valori consentiti: 1–14).")
        else:
            normalized.append(key)
    if len(normalized) != len(set(normalized)):
        report.warning(f"{label}: sono presenti allergeni duplicati.")


def validate_tags(value: object, label: str, report: Report) -> None:
    if not isinstance(value, list):
        report.error(f"{label}: tag deve essere una lista.")
        return
    normalized: list[str] = []
    for tag in value:
        if not isinstance(tag, str):
            report.error(f"{label}: tag '{tag}' non supportato (consentiti: {', '.join(sorted(ALLOWED_TAGS))}).")
        elif tag in ALLOWED_TAGS:
            normalized.append(tag)
        elif tag in LEGACY_SUPPORTED_TAGS:
            normalized.append(tag)
            report.record_legacy_tag(tag, label)
        else:
            report.error(f"{label}: tag '{tag}' non supportato (consentiti: {', '.join(sorted(ALLOWED_TAGS))}).")
    if len(normalized) != len(set(normalized)):
        report.warning(f"{label}: sono presenti tag duplicati.")


def validate_url(value: object, label: str, report: Report) -> None:
    if value in (None, ""):
        return
    if not isinstance(value, str):
        report.warning(f"{label}: il riferimento URL dovrebbe essere testo.")
        return
    parsed = urlparse(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        report.warning(f"{label}: URL probabilmente non valido ('{value}').")


def validate_contact_fields(menu: Mapping[str, object], report: Report) -> None:
    phone = menu.get("telefono")
    if phone not in (None, ""):
        if not isinstance(phone, str):
            report.warning("telefono: il recapito dovrebbe essere testo.")
        else:
            digits = PHONE_DIGITS_PATTERN.sub("", phone)
            if not 6 <= len(digits) <= 15:
                report.warning(f"telefono: formato probabilmente non valido ('{phone}').")

    instagram = menu.get("instagram")
    if instagram not in (None, ""):
        if not isinstance(instagram, str) or not INSTAGRAM_PATTERN.fullmatch(instagram.strip()):
            report.warning(f"instagram: usa solo l'handle, senza URL ('{instagram}').")

    validate_url(menu.get("maps"), "maps", report)
    for key in ("url", "sito", "website"):
        validate_url(menu.get(key), key, report)


def validate_translations(essential_values: list[tuple[str, object]], languages: list[str], report: Report) -> None:
    if not languages:
        return
    primary = languages[0]
    for language in languages:
        translated_fields = sum(1 for _, value in essential_values if localized_text(value, language))
        if translated_fields == 0:
            report.error(f"lingue: '{language}' è dichiarata, ma non compare nei contenuti essenziali tradotti.")

    missing_secondary: dict[str, list[str]] = {language: [] for language in languages if language != primary}
    for label, value in essential_values:
        if not isinstance(value, Mapping):
            continue
        for language in languages:
            if localized_text(value, language):
                continue
            if language == primary:
                report.error(f"{label}: manca la traduzione della lingua principale '{language}'.")
            else:
                missing_secondary[language].append(label)

    for language, labels in missing_secondary.items():
        if not labels:
            continue
        examples = ", ".join(labels[:3])
        suffix = "…" if len(labels) > 3 else ""
        report.warning(
            f"{len(labels)} contenuti essenziali non hanno la traduzione in '{language}' "
            f"(avviso non bloccante; esempi: {examples}{suffix})."
        )


def validate_premium(value: object, report: Report) -> None:
    """Blocco «premium» (menu su misura): solo aspetto, mai dati del menu."""
    if not isinstance(value, Mapping):
        report.error("premium deve essere un oggetto JSON.")
        return
    for key in value:
        if key not in PREMIUM_KEYS:
            report.error(f"premium: campo '{key}' non previsto.")
    if "direzione" in value and value["direzione"] not in PREMIUM_DIRECTIONS:
        report.error(f"premium.direzione '{value['direzione']}' non supportata ({', '.join(sorted(PREMIUM_DIRECTIONS))}).")
    if "caratteri" in value and value["caratteri"] not in PREMIUM_FONTS:
        report.error(f"premium.caratteri '{value['caratteri']}' non supportati ({', '.join(sorted(PREMIUM_FONTS))}).")
    colors = value.get("colori", {})
    if not isinstance(colors, Mapping):
        report.error("premium.colori deve essere un oggetto.")
    else:
        for key, color in colors.items():
            if key not in PREMIUM_COLORS or not isinstance(color, str) or not HEX_COLOR.match(color):
                report.error(f"premium.colori.{key}: usa un colore esadecimale #rrggbb.")
    for key in ("logo", "copertina"):
        if key in value:
            src = value[key]
            if not isinstance(src, str) or not (src.startswith("https://") or IMAGE_PATH.match(src)):
                report.error(f"premium.{key}: serve un indirizzo https o un file immagine del sito.")


def validate_menu(path: Path, report: Report) -> None:
    report.start_file(path)
    errors_before = report.errors
    warnings_before = report.warnings

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except UnicodeDecodeError:
        report.error("il file non è UTF-8.")
        return
    except json.JSONDecodeError as exc:
        report.error(f"JSON non valido: riga {exc.lineno}, colonna {exc.colno}: {exc.msg}.")
        return

    if not isinstance(data, Mapping):
        report.error("la radice del file deve essere un oggetto JSON.")
        return

    if not non_empty_text(data.get("nome")):
        report.error("manca un nome del locale non vuoto ('nome').")

    if "tema" in data and data["tema"] not in ALLOWED_THEMES:
        report.error(f"tema '{data['tema']}' non supportato (consentiti: {', '.join(sorted(ALLOWED_THEMES))}).")

    if "premium" in data:
        validate_premium(data["premium"], report)

    languages: list[str] = []
    if "lingue" in data:
        value = data["lingue"]
        if not isinstance(value, list) or not value:
            report.error("lingue deve essere una lista non vuota quando è dichiarata.")
        else:
            seen: set[str] = set()
            for item in value:
                if not isinstance(item, str) or not re.fullmatch(r"[a-z]{2}", item.strip()):
                    report.error(f"lingue: codice non valido '{item}'. Usa un codice ISO a due lettere, ad esempio it o en.")
                    continue
                language = item.strip()
                if language in seen:
                    report.error(f"lingue: '{language}' è dichiarata più di una volta.")
                    continue
                seen.add(language)
                languages.append(language)
                if language not in SUPPORTED_UI_LANGUAGES:
                    report.warning(f"lingue: '{language}' non ha testi di interfaccia dedicati nel visualizzatore e userà il fallback italiano.")

    sections = data.get("sezioni")
    if not isinstance(sections, list) or not sections:
        report.error("manca almeno una sezione non vuota ('sezioni').")
        return

    essential_values: list[tuple[str, object]] = [("nome", data.get("nome"))]
    for section_index, section in enumerate(sections, start=1):
        section_label = f"sezione {section_index}"
        if not isinstance(section, Mapping):
            report.error(f"{section_label}: deve essere un oggetto JSON.")
            continue

        section_name = section.get("nome")
        if not non_empty_text(section_name):
            report.error(f"{section_label}: manca un nome non vuoto.")
        else:
            essential_values.append((f"{section_label}.nome", section_name))

        if "tipo" in section and section["tipo"] not in {"degustazione"}:
            report.error(f"{section_label}: tipo '{section['tipo']}' non supportato (consentito: degustazione).")
        if "prezzo" in section:
            validate_price(section["prezzo"], section_label, report)

        items = section.get("voci")
        if not isinstance(items, list) or not items:
            report.error(f"{section_label}: deve contenere almeno una voce in 'voci'.")
            continue

        for item_index, item in enumerate(items, start=1):
            item_label = f"{section_label}, voce {item_index}"
            if not isinstance(item, Mapping):
                report.error(f"{item_label}: deve essere un oggetto JSON.")
                continue

            item_name = item.get("nome")
            if not non_empty_text(item_name):
                report.error(f"{item_label}: manca un nome non vuoto.")
            else:
                essential_values.append((f"{item_label}.nome", item_name))

            if "prezzo" in item:
                validate_price(item["prezzo"], item_label, report)
            if "prezzi" in item:
                variants = item["prezzi"]
                if not isinstance(variants, list) or not variants:
                    report.error(f"{item_label}: 'prezzi' deve essere una lista di varianti (etichetta + prezzo).")
                else:
                    for variant_index, variant in enumerate(variants, start=1):
                        if not isinstance(variant, Mapping) or not non_empty_text(variant.get("etichetta")):
                            report.error(f"{item_label}, variante {variant_index}: manca l'etichetta (es. calice, bottiglia).")
                            continue
                        validate_price(variant.get("prezzo"), f"{item_label}, variante {variant_index}", report)
            if "allergeni" in item:
                validate_allergens(item["allergeni"], item_label, report)
            if "tag" in item:
                validate_tags(item["tag"], item_label, report)

    validate_translations(essential_values, languages, report)
    validate_contact_fields(data, report)
    report.flush_compatibility_warnings()

    if report.errors == errors_before and report.warnings == warnings_before:
        report.ok()


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Controlla i JSON pubblicati in menus/ senza modificarli.")
    parser.add_argument(
        "--directory",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "menus",
        help="cartella JSON da controllare (predefinita: menus/ del repository)",
    )
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    directory = arguments.directory.resolve()
    print("RenMenu — controllo JSON dei menù")
    print(f"Cartella: {directory}")

    report = Report()
    if not directory.is_dir():
        print("\nERRORE: la cartella menus/ non esiste o non è leggibile.")
        print("\nESITO FINALE: NON PUBBLICARE")
        return 1

    files = sorted(directory.glob("*.json"))
    if not files:
        print("\nERRORE: nessun file .json trovato.")
        print("\nESITO FINALE: NON PUBBLICARE")
        return 1

    for path in files:
        validate_menu(path, report)

    print("\n--- Riepilogo ---")
    print(f"File controllati: {report.files}")
    print(f"Errori bloccanti: {report.errors}")
    print(f"Avvisi: {report.warnings}")
    if report.errors:
        print("ESITO FINALE: NON PUBBLICARE")
        return 1
    print("ESITO FINALE: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
