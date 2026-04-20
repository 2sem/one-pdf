from pathlib import Path


def escape_pdf_text(value: str) -> str:
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def build_pdf(page_texts: list[str]) -> bytes:
    objects: list[bytes] = []
    page_ids = []
    font_id = 3
    next_id = 4

    for page_text in page_texts:
      content_id = next_id
      page_id = next_id + 1
      next_id += 2

      stream = f"BT\n/F1 24 Tf\n72 720 Td\n({escape_pdf_text(page_text)}) Tj\nET"
      content_object = (
          f"{content_id} 0 obj\n<< /Length {len(stream.encode('utf-8'))} >>\nstream\n{stream}\nendstream\nendobj\n"
      ).encode("utf-8")
      page_object = (
          f"{page_id} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
          f"/Resources << /Font << /F1 {font_id} 0 R >> >> /Contents {content_id} 0 R >>\nendobj\n"
      ).encode("utf-8")

      objects.append(content_object)
      objects.append(page_object)
      page_ids.append(page_id)

    kids = " ".join(f"{page_id} 0 R" for page_id in page_ids)
    catalog = b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
    pages = f"2 0 obj\n<< /Type /Pages /Count {len(page_ids)} /Kids [{kids}] >>\nendobj\n".encode("utf-8")
    font = b"3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"

    full_objects = [catalog, pages, font, *objects]
    buffer = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]

    for obj in full_objects:
        offsets.append(len(buffer))
        buffer.extend(obj)

    xref_offset = len(buffer)
    buffer.extend(f"xref\n0 {len(offsets)}\n".encode("utf-8"))
    buffer.extend(b"0000000000 65535 f \n")

    for offset in offsets[1:]:
        buffer.extend(f"{offset:010d} 00000 n \n".encode("utf-8"))

    trailer = (
        f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n"
    ).encode("utf-8")
    buffer.extend(trailer)
    return bytes(buffer)


def main() -> None:
    fixtures = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
    fixtures.mkdir(parents=True, exist_ok=True)

    samples = {
        "sample-a.pdf": ["Sample A - Page 1", "Sample A - Page 2", "Sample A - Page 3"],
        "sample-b.pdf": ["Sample B - Page 1", "Sample B - Page 2"],
    }

    for filename, pages in samples.items():
        (fixtures / filename).write_bytes(build_pdf(pages))


if __name__ == "__main__":
    main()
