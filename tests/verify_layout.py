"""Detailed layout diagnostic after fixes"""
from playwright.sync_api import sync_playwright
import os

SCREENSHOTS_DIR = r"E:\Such_Proj\Other\EncyHub\tests\screenshots"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})

    # Dashboard
    page.goto("http://127.0.0.1:9524/", wait_until="networkidle", timeout=15000)
    page.wait_for_timeout(2000)

    # Identify the p-6 element with 0px padding
    result = page.evaluate("""() => {
        const els = document.querySelectorAll('[class*="p-6"]');
        return Array.from(els).map((el, i) => {
            const s = getComputedStyle(el);
            return {
                index: i,
                tag: el.tagName,
                className: el.className.substring(0, 120),
                padding: s.padding,
                parentTag: el.parentElement?.tagName,
                parentClass: el.parentElement?.className?.substring(0, 80),
                innerHTML: el.innerHTML.substring(0, 100),
            };
        });
    }""")
    print("=== p-6 elements on Dashboard ===")
    for r in result:
        print(f"  [{r['index']}] <{r['tag']}> padding={r['padding']}")
        print(f"      class: {r['className']}")
        print(f"      parent: <{r['parentTag']}> {r['parentClass']}")
        print(f"      content: {r['innerHTML'][:80]}...")
        print()

    # Check common Tailwind spacing utilities
    spacing_check = page.evaluate("""() => {
        const checks = [
            { sel: '.p-4', prop: 'padding', expected: '16px' },
            { sel: '.p-5', prop: 'padding', expected: '20px' },
            { sel: '.p-6', prop: 'padding', expected: '24px' },
            { sel: '.py-4', prop: 'paddingTop', expected: '16px' },
            { sel: '.px-4', prop: 'paddingLeft', expected: '16px' },
            { sel: '.mb-4', prop: 'marginBottom', expected: '16px' },
            { sel: '.mb-6', prop: 'marginBottom', expected: '24px' },
            { sel: '.mt-2', prop: 'marginTop', expected: '8px' },
            { sel: '.gap-6', prop: 'gap', expected: '24px' },
        ];
        return checks.map(c => {
            const el = document.querySelector(c.sel);
            if (!el) return { ...c, actual: 'NOT FOUND' };
            const actual = getComputedStyle(el)[c.prop];
            return { ...c, actual, ok: actual === c.expected };
        });
    }""")
    print("=== Tailwind spacing utility check ===")
    for s in spacing_check:
        status = "OK" if s.get('ok') else "FAIL"
        if s['actual'] == 'NOT FOUND':
            status = "N/A"
        print(f"  {status}: {s['sel']} -> {s['prop']} = {s['actual']} (expected {s['expected']})")

    # Check overall page layout dimensions
    layout = page.evaluate("""() => {
        const main = document.querySelector('main') || document.querySelector('#root > div');
        const sidebar = document.querySelector('nav') || document.querySelector('[class*="sidebar"]') || document.querySelector('[class*="w-64"]');
        return {
            body: { w: document.body.offsetWidth, h: document.body.offsetHeight },
            main: main ? { w: main.offsetWidth, h: main.offsetHeight, padding: getComputedStyle(main).padding, class: main.className.substring(0, 80) } : null,
            sidebar: sidebar ? { w: sidebar.offsetWidth, h: sidebar.offsetHeight, class: sidebar.className.substring(0, 80) } : null,
        };
    }""")
    print(f"\n=== Layout dimensions ===")
    print(f"  body: {layout['body']}")
    print(f"  main: {layout['main']}")
    print(f"  sidebar: {layout['sidebar']}")

    # ADB Master page
    page.goto("http://127.0.0.1:9524/adb_master", wait_until="networkidle", timeout=15000)
    page.wait_for_timeout(1500)

    adb_layout = page.evaluate("""() => {
        const cards = document.querySelectorAll('.glass-card');
        return Array.from(cards).map((c, i) => ({
            index: i,
            padding: getComputedStyle(c).padding,
            margin: getComputedStyle(c).margin,
            width: c.offsetWidth,
            height: c.offsetHeight,
            class: c.className.substring(0, 100),
        }));
    }""")
    print(f"\n=== ADB Master glass-cards ===")
    for c in adb_layout:
        print(f"  Card {c['index']}: {c['width']}x{c['height']} padding={c['padding']} margin={c['margin']}")
        print(f"    class: {c['class']}")

    # Check for the logcat panel structure
    logcat_info = page.evaluate("""() => {
        // Find elements with "Logcat" text
        const all = document.querySelectorAll('*');
        for (const el of all) {
            if (el.textContent.includes('Logcat') && el.children.length > 0) {
                const tag = el.tagName;
                const role = el.getAttribute('role');
                if (tag === 'DIV' && role === 'button') {
                    return { found: true, tag, role, class: el.className.substring(0, 100) };
                }
            }
        }
        return { found: false, note: 'Logcat panel not rendered (no device selected?)' };
    }""")
    print(f"\n=== Logcat panel ===")
    print(f"  {logcat_info}")

    browser.close()
    print("\nDiagnostic complete.")
