"""
Converte as imagens do diretorio JBS para WebP otimizado.
- Logo e icones -> lossless (preserva cores exatas do cliente)
- Fotos / obras -> quality 82 (balanco de peso e qualidade)
Saida: pasta ./assets/
"""
import os
from pathlib import Path
from PIL import Image, ImageOps

ROOT = Path(__file__).parent
OUT = ROOT / "assets"
OUT.mkdir(exist_ok=True)

MAX_PHOTO_WIDTH = 1600  # reduz fotos enormes de WhatsApp
QUALITY = 82

# mapeamento amigavel -> nome de saida
RENAME_MAP = {
    "LOGO JONATHAN BERLEZI 2.png": "logo-jbs.webp",
    "ICON JONATHAN BERLEZI.png": "icon-jbs.webp",
    "PERFIL-JONATHAN-BERLEZI-(PRETO-01).png": "perfil-jbs.webp",
    "WhatsApp Image 2026-04-01 at 16.24.03.jpeg": "projeto-01.webp",
    "WhatsApp Image 2026-04-01 at 16.24.13.jpeg": "projeto-02.webp",
    "WhatsApp Image 2026-04-01 at 17.07.04.jpeg": "obra-financiada-01.webp",
    "WhatsApp Image 2026-04-01 at 17.08.16.jpeg": "interior-01.webp",
    "WhatsApp Image 2026-04-01 at 17.08.17 (1).jpeg": "interior-02.webp",
    "WhatsApp Image 2026-04-01 at 17.08.17 (2).jpeg": "interior-03.webp",
    "WhatsApp Image 2026-04-01 at 17.08.17 (3).jpeg": "interior-04.webp",
    "WhatsApp Image 2026-04-01 at 17.08.17.jpeg": "interior-05.webp",
    "WhatsApp Image 2026-04-01 at 17.10.21.jpeg": "fachada-premium-01.webp",
    "WhatsApp Image 2026-04-01 at 17.10.55.jpeg": "fachada-premium-02.webp",
    "WhatsApp Image 2026-04-01 at 17.13.44.jpeg": "fachada-padrao-01.webp",
    "WhatsApp Image 2026-04-01 at 17.14.26.jpeg": "fachada-financiada-01.webp",
    "WhatsApp Image 2026-04-01 at 17.14.52.jpeg": "interior-sala-01.webp",
    "WhatsApp Image 2026-04-01 at 17.15.19.jpeg": "interior-06.webp",
    "WhatsApp Image 2026-04-02 at 10.12.39.jpeg": "obra-entregue-01.webp",
    "WhatsApp Image 2026-04-02 at 10.13.09.jpeg": "obra-entregue-02.webp",
    "WhatsApp Image 2026-04-02 at 10.13.28.jpeg": "cozinha-gourmet-01.webp",
    "WhatsApp Image 2026-04-02 at 10.13.53.jpeg": "obra-entregue-03.webp",
}

def convert(src: Path, dst: Path, lossless: bool):
    img = Image.open(src)
    img = ImageOps.exif_transpose(img)  # respeita orientacao EXIF
    if img.mode == "P":
        img = img.convert("RGBA")
    if not lossless and img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGB")

    # redimensiona fotos largas
    if not lossless and img.width > MAX_PHOTO_WIDTH:
        ratio = MAX_PHOTO_WIDTH / img.width
        new_size = (MAX_PHOTO_WIDTH, int(img.height * ratio))
        img = img.resize(new_size, Image.LANCZOS)

    if lossless:
        img.save(dst, "WEBP", lossless=True, quality=100, method=6)
    else:
        img.save(dst, "WEBP", quality=QUALITY, method=6)


count = 0
for src_name, out_name in RENAME_MAP.items():
    src = ROOT / src_name
    if not src.exists():
        print(f"[SKIP] {src_name} nao encontrado")
        continue
    dst = OUT / out_name
    lossless = src_name.lower().endswith(".png")  # preserva logos
    convert(src, dst, lossless)
    size_kb = dst.stat().st_size / 1024
    print(f"[OK] {src_name}  ->  assets/{out_name}  ({size_kb:.1f} KB)")
    count += 1

print(f"\nConvertidas {count} imagens para WebP em {OUT}")
