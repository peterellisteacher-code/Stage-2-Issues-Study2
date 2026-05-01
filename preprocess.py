"""Pre-process for Issues Study Lab MVP.

For each of 5 sample questions:
- Resolve hand-picked PDFs in the Philosophy Texts library
- For PDFs > SIZE_THRESHOLD bytes, extract text via PyMuPDF and save
  to lab/text_packs/{slug}.text.pdf so the cache stays under the
  ~8 MB inline limit per createCachedContent call
- Emit lab/lab_corpus.json (modelled on Epistemology/unit_corpus.json)

Also extracts Word-doc text for the SACE rubric, task sheet, and 3 exemplars
to lab/extracted_docx/*.txt for use by the /api/feedback endpoint.
"""
import json
import os
import sys
from pathlib import Path

import fitz  # PyMuPDF
import docx

LIB = Path(r"C:\Users\Peter Ellis\OneDrive\Teaching\Philosophy\Philosophy Texts")
ISSUES = Path(r"C:\Users\Peter Ellis\OneDrive\Teaching\2026\12PHIL - 2026\Issues Study")
LAB = ISSUES / "lab"
TEXT_PACKS = LAB / "text_packs"
EXTRACTED = LAB / "extracted_docx"
TEXT_PACKS.mkdir(exist_ok=True)
EXTRACTED.mkdir(exist_ok=True)

# Cap each cache around 6 MB inline to stay safely under the ~8 MB Vertex limit.
PER_PACK_BUDGET_BYTES = 6 * 1024 * 1024
# Files this large will be pre-emptively text-extracted regardless of pack total
LARGE_FILE_BYTES = 2 * 1024 * 1024

SAMPLE_QUESTIONS = [
    {
        "id": "lab_q001",
        "domain": "ethics",
        "text": "Is the rapid development of Artificial Intelligence morally justifiable?",
        "philosophers_suggested": ["Bostrom", "Singer", "Floridi", "Kant", "Rachels"],
        "display_name": "Q1 Ethics — AI",
        "system_instruction": (
            "You are assisting a SACE Stage 2 Philosophy student on an Issues Study "
            "investigating: 'Is the rapid development of Artificial Intelligence morally "
            "justifiable?' Frame this through APPLIED ETHICS — utilitarian, deontological, "
            "and virtue-ethics positions on AI development. When quoting, use exact text "
            "from the cached materials and cite filename + page where possible. Distinguish "
            "what each philosopher actually argues from objections others might raise. "
            "Stay focused on philosophical argument, not journalism."
        ),
        "files": [
            "AI/Nick Bostrom - The Ethics of Artificial Intelligence.pdf",
            "AI/Bostrom and Yudkowsky - The Ethics of Artificial Intelligence.pdf",
            "AI/Floridi - The Ethics of Artificial Intelligence.pdf",
            "AI/Chapters 4 and 5 - Floridi - The Ethics of Artificial Intelligence.pdf",
            "Ethics/James Rachels - Elements of Moral Philosophy 10e in Chapters/James Rachels textbook - the utilitarian approach.pdf",
            "Ethics/James Rachels - Elements of Moral Philosophy 10e in Chapters/James Rachels textbook - The debate over utilitarianism.pdf",
            "Ethics/James Rachels - Elements of Moral Philosophy 10e in Chapters/Kant and Respect for Persons.pdf",
            "Ethics/James Rachels - Elements of Moral Philosophy 10e in Chapters/Are there absolute moral rules.pdf",
            "Ethics/Virtue Ethics/Rosalind Hursthouse - Normative Virtue Ethics.pdf",
        ],
    },
    {
        "id": "lab_q002",
        "domain": "metaphysics",
        "text": "Is the self an illusion?",
        "philosophers_suggested": ["Hume", "Williams", "Dennett", "Metzinger", "Plato"],
        "display_name": "Q2 Metaphysics — Self",
        "system_instruction": (
            "You are assisting a SACE Stage 2 Philosophy student on an Issues Study "
            "investigating: 'Is the self an illusion?' Frame this through METAPHYSICS / "
            "PERSONAL IDENTITY — Hume's bundle theory, Bernard Williams's continuity "
            "thought experiments, Dennett on self-as-narrative-centre, Metzinger's no-self "
            "theory, Plato/Cartesian substance views. When quoting, cite filename + page. "
            "Distinguish what each thinker actually argues from objections."
        ),
        "files": [
            "David Hume - Empiricism.pdf",
            "Personal Identity/Bernard Williams - The Self and the Future.pdf",
            "Personal Identity/Bernard Williams On Personal Identity Thought Experiments In “The Self and the Future”.pdf",
            "Personal Identity/Outline - Williams on Expectations and the Self.pdf",
            "Personal Identity/Williams Handout - Subjective Experience.pdf",
            "Personal Identity/Simon Beck - Back to the Future and the Self.pdf",
            "Personal Identity/Daniel Dennett - Facing up to the hard question of consciousness.pdf",
            "Personal Identity/Thomas Metzinger - Being No One.pdf",
            "General Metaphysics/Platos Theory of Forms - Philosophy Now Issue 90 - David Macintosh.pdf",
        ],
    },
    {
        "id": "lab_q003",
        "domain": "epistemology",
        "text": "What a culture deems 'common sense' is mostly ideology, not knowledge.",
        "philosophers_suggested": ["Žižek", "Stanley", "Mills", "Marx", "Storey"],
        "display_name": "Q3 Epistemology — Ideology",
        "system_instruction": (
            "You are assisting a SACE Stage 2 Philosophy student on an Issues Study "
            "investigating: 'What a culture deems common sense is mostly ideology, not "
            "knowledge.' Frame this through EPISTEMOLOGY — knowledge versus belief, "
            "ideology critique (Žižek, Stanley), ordinary-language defence of common sense "
            "(Moore-style), and political-epistemology objections. When quoting, cite "
            "filename + page. Stay framed as epistemology (knowledge / justification), "
            "not just politics."
        ),
        "files": [
            "Zizek/Zizek - The Sublime Object of Ideology.pdf",
            "Zizek/Tolerance as an ideological category - politics.pdf",
            "Zizek/zizek - 2009 - first as tragedy then as farce.pdf",
            "Epistemology/How Propaganda Works.pdf",
            "An Epistemological Account of the Logic of Propaganda.pdf",
            "Epistemology/Modernism Postmodernism and Metamodernism/Introduction to Poststructuralism.pdf",
            "Epistemology/Modernism Postmodernism and Metamodernism/Postmodernism a very short introduction - 2002 - Christopher Butler.pdf",
            "Rationalism vs Romanticism.pdf",
        ],
    },
    {
        "id": "lab_q004",
        "domain": "political",
        "text": "To what extent is democracy the most appropriate form of government?",
        "philosophers_suggested": ["Plato", "Hobbes", "Locke", "Rawls", "Mill"],
        "display_name": "Q4 Political — Democracy",
        "system_instruction": (
            "You are assisting a SACE Stage 2 Philosophy student on an Issues Study "
            "investigating: 'To what extent is democracy the most appropriate form of "
            "government?' Frame this through POLITICAL PHILOSOPHY — Plato's rule-of-the-wise "
            "objection, Hobbes's sovereignty argument, Locke/Mill liberal-democratic "
            "defences, Rawls on justice. When quoting, cite filename + page. Distinguish "
            "each thinker's position from objections."
        ),
        "files": [
            "Ethics/An Introduction to Political Philosophy by Jonathan Wolff.pdf",
            "Ethics/Political Philosophy/Jonathan Wolff excerpt -- Rawls VoI and OP.pdf",
            "Ethics/The Social Contract/John Rawls - A Theory of Justice.pdf",
            "Ethics/The Social Contract/Thomas Hobbes - Leviathan.pdf",
            "Ethics/The Social Contract/Hobbes and Locke.pdf",
            "Ethics/The Social Contract/Rachels - The Social Contract.pdf",
            "Ethics/The Social Contract/T M Scanlon - Contractualism and Utilitarianism.pdf",
            "Ethics/Nietzche - Master Morality and Slave Morality.pdf",
            "Ethics/James Rachels - Elements of Moral Philosophy 10e in Chapters/6 - James Rachels - Social Contract.pdf",
        ],
    },
    {
        "id": "lab_q005",
        "domain": "mind_tech",
        "text": "Is it possible for philosophical zombies to exist?",
        "philosophers_suggested": ["Chalmers", "Jackson", "Dennett", "Block", "Nagel"],
        "display_name": "Q5 Mind — Phil Zombies",
        "system_instruction": (
            "You are assisting a SACE Stage 2 Philosophy student on an Issues Study "
            "investigating: 'Is it possible for philosophical zombies to exist?' Frame "
            "this through PHILOSOPHY OF MIND — Jackson's knowledge argument, Block on "
            "qualia, Nagel's bat, Ravenscroft on dualism / functionalism / identity "
            "theory, Princess Elisabeth's interaction problem. When quoting, cite "
            "filename + page. Distinguish what each thinker argues from objections."
        ),
        "files": [
            "Mind Watch to Functionalism/Frank Jackson - 1982 - Epiphenomenal Qualia.pdf",
            "Mind Watch to Functionalism/6 - What Mary Didn't Know - Frank Jackson.pdf",
            "Mind Watch to Functionalism/Bacs - 2018 - Mental Fictionalism and Epiphenomenal Qualia.pdf",
            "Mind Watch to Functionalism/Ned Block - 2007 - Wittgenstein and Qualia.pdf",
            "Mind Watch to Functionalism/Ravenscroft - The Identity Theory.pdf",
            "Mind Watch to Functionalism/Ravenscroft - Functionalism.pdf",
            "Mind Watch to Functionalism/Princess Elisabeths response to dualism.pdf",
            "Personal Identity/Nagel - What is it like to be a bat.pdf",
            "Muller - 2008 - Why Qualia are not Epiphenomenal.pdf",
            "Ian Ravenscroft - Dualism.pdf",
        ],
    },
]


def slugify(s: str) -> str:
    out = []
    for ch in s:
        if ch.isalnum():
            out.append(ch.lower())
        elif ch in (" ", "-", "_"):
            out.append("_")
    return "".join(out).strip("_")


def extract_pdf_to_text_pdf(src: Path, dst: Path) -> int:
    """Extract text from src PDF and write a new PDF with that text on plain pages.

    Returns the byte size of the new file. We write a real PDF (not a .txt) so
    Vertex receives application/pdf parts as expected by load_media_part.
    """
    src_doc = fitz.open(str(src))
    text_pages = []
    for page in src_doc:
        text_pages.append(page.get_text("text"))
    src_doc.close()
    text = "\n\n----- page break -----\n\n".join(text_pages)

    dst_doc = fitz.open()
    # Story API is overkill — just build pages of plain text wrapped to fit.
    page_size = fitz.paper_rect("a4")
    margin = 50
    rect = fitz.Rect(margin, margin, page_size.x1 - margin, page_size.y1 - margin)
    chunk_size = 3500
    chunks = [text[i : i + chunk_size] for i in range(0, len(text), chunk_size)] or [""]
    for chunk in chunks:
        page = dst_doc.new_page(width=page_size.width, height=page_size.height)
        page.insert_textbox(rect, chunk, fontsize=9, fontname="helv")
    dst_doc.save(str(dst), deflate=True, clean=True)
    dst_doc.close()
    return dst.stat().st_size


def resolve_file(rel: str) -> Path:
    p = LIB / rel
    if not p.exists():
        # Try Unicode-curly-quote variant fix
        alt = rel.replace("“", "_").replace("”", "_")
        if (LIB / alt).exists():
            return LIB / alt
        raise FileNotFoundError(f"Not in library: {rel}")
    return p


def process_pack(q: dict) -> dict:
    final_files = []  # paths relative to LIB or absolute
    total = 0
    skipped = []
    for rel in q["files"]:
        try:
            src = resolve_file(rel)
        except FileNotFoundError as e:
            skipped.append({"file": rel, "reason": "not found"})
            continue
        size = src.stat().st_size
        # If file is large, extract text into lab/text_packs/<slug>.text.pdf
        if size > LARGE_FILE_BYTES:
            slug = slugify(Path(rel).stem) + ".text.pdf"
            dst = TEXT_PACKS / slug
            if dst.exists():
                new_size = dst.stat().st_size
            else:
                try:
                    new_size = extract_pdf_to_text_pdf(src, dst)
                except Exception as e:
                    skipped.append({"file": rel, "reason": f"text extract failed: {e}"})
                    continue
            final_files.append({
                "abs_path": str(dst),
                "size": new_size,
                "extracted_from": str(src),
                "original_size": size,
            })
            total += new_size
        else:
            final_files.append({
                "abs_path": str(src),
                "size": size,
            })
            total += size
    # If still over budget, drop smallest text_packs first... actually drop largest
    if total > PER_PACK_BUDGET_BYTES:
        # sort by size descending and drop until under budget
        final_files.sort(key=lambda f: -f["size"])
        while total > PER_PACK_BUDGET_BYTES and final_files:
            dropped = final_files.pop(0)
            total -= dropped["size"]
            skipped.append({"file": dropped["abs_path"], "reason": f"pack budget exceeded; dropped (was {dropped['size']} bytes)"})
    return {
        "files": final_files,
        "total_bytes": total,
        "skipped": skipped,
    }


def main():
    corpus = {
        "_documentation": "Issues Study Lab MVP corpus. One pack per sample question. Files are absolute paths because they span the Issues Study folder and the Philosophy Texts library.",
        "default_model": "gemini-2.5-pro",
        "default_ttl_seconds": 6048000,
        "default_system_instruction": (
            "You are a Socratic study partner for a SACE Stage 2 Philosophy student "
            "investigating an Issues Study question. Always cite the cached texts when "
            "you make a claim about a thinker. If asked something the cached texts don't "
            "support, say so explicitly rather than invent. Respond at Year 12 level: "
            "philosophical terminology, but accessible explanations."
        ),
        "packs": {},
    }
    pack_meta = {}
    for q in SAMPLE_QUESTIONS:
        print(f"\n=== {q['id']}: {q['display_name']} ===")
        result = process_pack(q)
        print(f"  files: {len(result['files'])}   total: {result['total_bytes']:,} bytes   skipped: {len(result['skipped'])}")
        for sk in result["skipped"]:
            print(f"    SKIP: {sk}")

        files_for_corpus = [f["abs_path"] for f in result["files"]]
        # In unit_corpus.json, files are relative to corpus_path's directory.
        # We'll set corpus_path = LAB / lab_corpus.json. Use absolute paths so resolution
        # works regardless of relative depth. The MCP server's _load_media_part should
        # accept absolute paths via Path resolution.
        # Verify by storing absolute strings; the MCP code does `corpus_root / rel` —
        # an absolute path joined with corpus_root via pathlib returns the absolute
        # path itself. Good.
        corpus["packs"][q["id"]] = {
            "display_name": q["display_name"],
            "system_instruction": q["system_instruction"],
            "files": files_for_corpus,
        }
        pack_meta[q["id"]] = {
            "domain": q["domain"],
            "question_text": q["text"],
            "display_name": q["display_name"],
            "philosophers_suggested": q["philosophers_suggested"],
            "files": result["files"],
            "skipped": result["skipped"],
            "total_bytes": result["total_bytes"],
        }
    (LAB / "lab_corpus.json").write_text(json.dumps(corpus, indent=2), encoding="utf-8")
    (LAB / "pack_metadata.json").write_text(json.dumps(pack_meta, indent=2), encoding="utf-8")
    print("\nWrote lab_corpus.json and pack_metadata.json")

    # Now extract docx text
    docs = {
        "task_sheet": "SACE EXEMPLAR TASK - AT3 - Investigation - Task (1).docx",
        "exemplar_a_minus": "SACE EXEMPLAR - AT3 - Investigation - Student 1 Response (A-).docx",
        "exemplar_c_plus": "SACE EXEMPLAR - AT3 - Investigation - Student 2 Response (Cplus).docx",
        "exemplar_b": "SACE EXEMPLAR - AT3 - Investigation - Student 3 Response (B).docx",
        "assessment_advice": "2025 Philosophy Subject Assessment Advice - Issues Study.docx",
        "subject_outline": "2025 - Stage 2 Philosophy Subject Outline - Issues Study.docx",
    }
    extracted = {}
    for key, fn in docs.items():
        path = ISSUES / fn
        if not path.exists():
            print(f"  MISSING DOCX: {fn}")
            continue
        d = docx.Document(str(path))
        text = "\n".join(p.text for p in d.paragraphs)
        out = EXTRACTED / f"{key}.txt"
        out.write_text(text, encoding="utf-8")
        extracted[key] = {"path": str(out), "chars": len(text)}
        print(f"  extracted {key}: {len(text)} chars -> {out.name}")
    (LAB / "extracted_docx" / "_index.json").write_text(json.dumps(extracted, indent=2), encoding="utf-8")
    print("\nDone.")


if __name__ == "__main__":
    main()
