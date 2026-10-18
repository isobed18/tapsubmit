"""Bounded, CPU-only private resume extraction shared by source and desktop workers."""
import argparse
import json
import logging
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import BadZipFile, ZipFile

MAX_BYTES = 12 * 1024 * 1024
MAX_TEXT = 100_000
MAX_PAGES = 30


class ResumeError(ValueError):
    """An actionable error safe to show without private file paths or contents."""


def extract_resume(path: Path) -> str:
    if path.stat().st_size > MAX_BYTES:
        raise ResumeError('Use a CV smaller than 12 MB.')
    extension = path.suffix.lower()
    if extension == '.pdf':
        text = _pdf_text(path)
    elif extension == '.docx':
        try:
            with ZipFile(path) as archive:
                info = archive.getinfo('word/document.xml')
                if info.file_size > 2_000_000:
                    raise ResumeError('This DOCX exceeds the text extraction budget. Export a simpler CV.')
                xml = archive.read(info)
            if b'<!DOCTYPE' in xml.upper() or b'<!ENTITY' in xml.upper():
                raise ResumeError('Unsupported DOCX XML. Export the CV again.')
            root = ET.fromstring(xml)
            ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
            text = '\n'.join(''.join(node.text or '' for node in p.findall('.//w:t', ns))
                             for p in root.findall('.//w:p', ns))
        except (BadZipFile, KeyError, ET.ParseError) as error:
            raise ResumeError('This DOCX could not be read. Export the CV again as PDF, DOCX or TXT.') from error
    elif extension == '.txt':
        try:
            text = path.read_text(encoding='utf-8-sig')
        except UnicodeError as error:
            raise ResumeError('Save this TXT CV with UTF-8 encoding, or use PDF or DOCX.') from error
    else:
        raise ResumeError('Choose a PDF, DOCX or UTF-8 TXT CV.')
    text = text.replace('\x00', '').strip()
    if len(text) > MAX_TEXT:
        raise ResumeError('The CV contains too much text. Use a shorter CV (up to 100,000 characters).')
    if len(text) < 80:
        raise ResumeError('The CV did not contain enough readable text. Use a text PDF, DOCX or TXT CV.')
    return text


def _pdf_text(path: Path) -> str:
    from pypdf import PdfReader, apply_configuration
    from pypdf.errors import PyPdfError

    logging.getLogger('pypdf').setLevel(logging.CRITICAL)
    try:
        with apply_configuration(zlib_maximum_output_length=5_000_000,
                                 lzw_maximum_output_length=5_000_000,
                                 run_length_maximum_output_length=5_000_000,
                                 array_based_stream_maximum_output_length=5_000_000,
                                 stream_decoding_work_maximum_length=20_000_000,
                                 xform_maximum_invocations_per_extraction=1_000), path.open('rb') as stream:
            reader = PdfReader(stream)
            if reader.is_encrypted:
                raise ResumeError('This PDF is password-protected. Upload an unlocked copy.')
            if len(reader.pages) > MAX_PAGES:
                raise ResumeError('Use a CV with no more than 30 pages.')
            parts = []
            total = 0
            for page in reader.pages:
                contents = page.get_contents()
                if contents is not None and len(contents.get_data()) > 5_000_000:
                    raise ResumeError('This PDF page is too complex. Export a simpler text PDF or use DOCX.')
                part = page.extract_text() or ''
                total += len(part)
                if total > MAX_TEXT:
                    raise ResumeError('The CV contains too much text. Use a shorter CV.')
                parts.append(part)
        text = '\n'.join(parts)
        if len(text.strip()) < 80:
            raise ResumeError('This PDF has too little selectable text and may need OCR. Use a text PDF, DOCX or TXT CV.')
        return text
    except ResumeError:
        raise
    except (PyPdfError, ValueError, KeyError, TypeError, RecursionError, OSError) as error:
        raise ResumeError('This PDF could not be read. Export it again as a text PDF, or use DOCX or TXT.') from error


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('resume', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        text = extract_resume(args.resume)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding='utf-8')
        args.output.chmod(0o600)
    except (ResumeError, OSError) as error:
        message = str(error) if isinstance(error, ResumeError) else 'The CV could not be read or saved on this computer.'
        print(json.dumps({'error': message}))
        raise SystemExit(2)
    print(json.dumps({'characters': len(text)}))


if __name__ == '__main__':
    main()
