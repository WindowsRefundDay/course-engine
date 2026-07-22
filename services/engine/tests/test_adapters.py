from pathlib import Path
from zipfile import ZipFile

from course_engine.adapters import adapter_for


def test_detects_zip_and_url_sources(tmp_path: Path) -> None:
    archive = tmp_path / "intro-calculus.zip"
    with ZipFile(archive, "w") as bundle:
        bundle.writestr("content_map.json", "{}")
        bundle.writestr("pages/index.html", "<main>Course</main>")

    zip_manifest = adapter_for(str(archive)).inventory(str(archive))
    assert zip_manifest.source_kind == "zip"
    assert zip_manifest.file_count == 2
    assert zip_manifest.has_content_map

    web_manifest = adapter_for("https://example.edu/calculus").inventory("https://example.edu/calculus")
    assert web_manifest.source_kind == "website"
    assert web_manifest.file_count == 0

    pdf = tmp_path / "course-notes.pdf"
    pdf.write_bytes(b"%PDF-1.7\n")
    pdf_manifest = adapter_for(str(pdf)).inventory(str(pdf))
    assert pdf_manifest.source_kind == "pdf"
    assert pdf_manifest.file_count == 1
