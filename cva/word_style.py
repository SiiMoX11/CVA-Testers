# -*- coding: utf-8 -*-
"""Mise en forme commune des documents Word téléchargeables : police Times New Roman partout."""
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

FONT = 'Times New Roman'
_THEME_ATTRS = ('w:asciiTheme', 'w:hAnsiTheme', 'w:eastAsiaTheme', 'w:cstheme')


def _set_rfonts(rpr):
    fonts = rpr.find(qn('w:rFonts'))
    if fonts is None:
        fonts = OxmlElement('w:rFonts')
        rpr.insert(0, fonts)
    for attr in _THEME_ATTRS:
        fonts.attrib.pop(qn(attr), None)
    for attr in ('w:ascii', 'w:hAnsi', 'w:eastAsia', 'w:cs'):
        fonts.set(qn(attr), FONT)


def _runs_in(element):
    for run in element.iter(qn('w:r')):
        rpr = run.find(qn('w:rPr'))
        if rpr is None:
            rpr = OxmlElement('w:rPr')
            run.insert(0, rpr)
        _set_rfonts(rpr)


def apply_times_new_roman(doc, headers=True):
    """Applique Times New Roman aux styles, au corps et (par défaut) aux en-têtes et pieds de page."""
    styles = doc.styles.element
    defaults = styles.find(qn('w:docDefaults'))
    if defaults is not None:
        rpr_default = defaults.find(qn('w:rPrDefault'))
        if rpr_default is not None:
            rpr = rpr_default.find(qn('w:rPr'))
            if rpr is None:
                rpr = OxmlElement('w:rPr')
                rpr_default.append(rpr)
            _set_rfonts(rpr)
    for style in styles.iter(qn('w:style')):
        rpr = style.find(qn('w:rPr'))
        if rpr is not None:
            _set_rfonts(rpr)
    _runs_in(doc.element.body)
    if headers:
        for section in doc.sections:
            for part in (section.header, section.footer, section.first_page_header, section.first_page_footer,
                         section.even_page_header, section.even_page_footer):
                try:
                    if not part.is_linked_to_previous:
                        _runs_in(part._element)
                except Exception:
                    pass
    return doc
