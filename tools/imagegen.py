#!/usr/bin/env python
"""Image-харнесс для мокапов/элементов интерфейса через CLIProxyAPI (gpt-image-2).

Прямой IP-эндпоинт (в обход Cloudflare, без 524 на долгих генерациях).
Использование:
  python tools/imagegen.py "промпт" out.png [--size 1024x1024] [--model gpt-image-2]
  python tools/imagegen.py "промпт" out.png --ref mockup.png   # правка по образцу (edits)

Назначение: генерировать РЕФЕРЕНС-мокапы улучшенной вёрстки экранов (по ревью Codex),
чтобы визуализировать до переноса в процедурный Canvas-рендер. Игра остаётся
zero-asset — сгенерированное используется как ориентир, не как ассет в билде.
"""
import sys, json, base64, urllib.request, argparse, os

# Прямой IP CLIProxyAPI (в обход Cloudflare). Ключ НЕ хранится в репозитории
# (публичный) — читается из env IMAGEGEN_KEY или локального tools/.imagegen-key.
BASE = os.environ.get("IMAGEGEN_BASE", "http://38.180.6.55:8317/v1")
_keyfile = os.path.join(os.path.dirname(__file__), ".imagegen-key")
KEY = os.environ.get("IMAGEGEN_KEY") or (
    open(_keyfile).read().strip() if os.path.exists(_keyfile) else "")
if not KEY:
    raise SystemExit("нет ключа: задай env IMAGEGEN_KEY или создай tools/.imagegen-key")


def _post(path, payload):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read().decode("utf-8"))


def generate(prompt, out, size="1024x1024", model="gpt-image-2"):
    data = _post("/images/generations", {
        "model": model, "prompt": prompt, "size": size, "n": 1,
    })
    item = data["data"][0]
    if item.get("b64_json"):
        raw = base64.b64decode(item["b64_json"])
    elif item.get("url"):
        with urllib.request.urlopen(item["url"], timeout=120) as r:
            raw = r.read()
    else:
        raise SystemExit(f"нет изображения в ответе: {json.dumps(data)[:400]}")
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with open(out, "wb") as f:
        f.write(raw)
    print(f"saved {out} ({len(raw)} bytes)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("prompt")
    ap.add_argument("out")
    ap.add_argument("--size", default="1024x1024")
    ap.add_argument("--model", default="gpt-image-2")
    a = ap.parse_args()
    generate(a.prompt, a.out, a.size, a.model)
