"""Tests for the theme-agnostic SVG rewriter."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from build_diagrams import themify  # noqa: E402


def test_fill_hex_becomes_a_semantic_class():
    src = '<polygon fill="#0d1c33" stroke="#4b90f7" points="0,0"/>'
    out = themify(src)
    assert 'fill="#0d1c33"' not in out
    assert 'stroke="#4b90f7"' not in out
    assert 'class="f-srv s-srv"' in out


def test_text_ink_becomes_a_text_class():
    src = '<text fill="#e8ecf4" x="1" y="2">hi</text>'
    out = themify(src)
    assert 'fill="#e8ecf4"' not in out
    assert 'class="t-ink"' in out


def test_existing_class_is_preserved_and_extended():
    src = '<g class="node"><polygon fill="#0d2416" stroke="#3fbf62"/></g>'
    out = themify(src)
    assert 'class="node"' in out
    assert 'class="f-ana s-ana"' in out


def test_transparent_and_none_are_left_alone():
    src = '<polygon fill="none" stroke="transparent"/>'
    out = themify(src)
    assert out == src


def test_unmapped_colour_raises_so_the_palette_cannot_drift():
    src = '<polygon fill="#123456"/>'
    try:
        themify(src)
    except ValueError as e:
        assert "#123456" in str(e)
    else:
        raise AssertionError("expected ValueError for an unmapped colour")


# --- regression tests: the rewriter must emit well-formed XML ---------------
# Graphviz emits self-closing <path/>, <polygon/> and <ellipse/> elements. A
# rewriter that appends the class attribute after the trailing "/" produces
# `<path d="…"/ class="f-rec">` — malformed, and every diagram fails to parse.


def test_self_closing_tags_stay_self_closing():
    src = '<path fill="#12100c" stroke="#4a3316" stroke-width="1.6" d="M1,2"/>'
    out = themify(src)
    assert out == '<path stroke-width="1.6" d="M1,2" class="f-rec s-rec"/>'


def test_an_existing_class_is_merged_not_duplicated():
    src = '<polygon class="node" fill="#0d2416" stroke="#3fbf62"/>'
    out = themify(src)
    assert out.count('class="') == 1
    assert 'class="node f-ana s-ana"' in out


def test_output_parses_as_xml():
    from xml.etree import ElementTree

    src = (
        '<svg xmlns="http://www.w3.org/2000/svg">'
        '<g id="node1" class="node"><title>a</title>'
        '<path fill="#12100c" stroke="#4a3316" d="M1,2"/>'
        '<text fill="#e8ecf4" x="1" y="2">hi</text>'
        "</g></svg>"
    )
    ElementTree.fromstring(themify(src))
