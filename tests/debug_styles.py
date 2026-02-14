"""Debug: inspect actual rendered styles and DOM issues"""
from playwright.sync_api import sync_playwright
import os

SCREENSHOTS_DIR = r"E:\Such_Proj\Other\EncyHub\tests\screenshots"
os.makedirs(SCREENSHOTS_DIR, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})

    errors = []
    page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)

    # Dashboard
    page.goto("http://127.0.0.1:9524/", wait_until="networkidle", timeout=15000)
    page.wait_for_timeout(2000)
    page.screenshot(path=os.path.join(SCREENSHOTS_DIR, "debug_dashboard.png"), full_page=True)

    # Check glass-card computed styles
    cards = page.locator(".glass-card").all()
    print(f"Dashboard glass-cards: {len(cards)}")
    for i, card in enumerate(cards[:3]):
        box = card.bounding_box()
        styles = card.evaluate("""el => {
            const s = getComputedStyle(el);
            return {
                padding: s.padding,
                margin: s.margin,
                width: s.width,
                height: s.height,
                display: s.display,
                gap: s.gap,
            }
        }""")
        print(f"  Card {i}: box={box}, styles={styles}")

    # Check if p-6 class actually applies padding
    p6_els = page.locator("[class*='p-6']").all()
    print(f"\nElements with p-6 class: {len(p6_els)}")
    for i, el in enumerate(p6_els[:3]):
        padding = el.evaluate("el => getComputedStyle(el).padding")
        print(f"  p-6 element {i}: padding={padding}")

    # Check gap on grid
    grids = page.locator("[class*='gap-']").all()
    print(f"\nElements with gap-* class: {len(grids)}")
    for i, el in enumerate(grids[:3]):
        gap = el.evaluate("el => getComputedStyle(el).gap")
        cls = el.evaluate("el => el.className")
        print(f"  gap element {i}: gap={gap}, class={cls[:80]}")

    # Navigate to ADB Master
    page.goto("http://127.0.0.1:9524/adb_master", wait_until="networkidle", timeout=15000)
    page.wait_for_timeout(1500)
    page.screenshot(path=os.path.join(SCREENSHOTS_DIR, "debug_adbmaster.png"), full_page=True)

    # Check for nested buttons (invalid HTML)
    nested = page.evaluate("""() => {
        const buttons = document.querySelectorAll('button button');
        return Array.from(buttons).map(b => ({
            text: b.textContent.trim().substring(0, 50),
            parent: b.parentElement.tagName,
        }));
    }""")
    print(f"\nNested buttons (invalid HTML): {len(nested)}")
    for n in nested:
        print(f"  {n}")

    # FlowSVN
    page.goto("http://127.0.0.1:9524/flow_svn", wait_until="networkidle", timeout=15000)
    page.wait_for_timeout(1000)
    page.screenshot(path=os.path.join(SCREENSHOTS_DIR, "debug_flowsvn.png"), full_page=True)

    # GmConsole
    page.goto("http://127.0.0.1:9524/gm_console", wait_until="networkidle", timeout=15000)
    page.wait_for_timeout(1000)
    page.screenshot(path=os.path.join(SCREENSHOTS_DIR, "debug_gmconsole.png"), full_page=True)

    print(f"\nConsole errors: {len(errors)}")
    for e in errors[:5]:
        print(f"  {e}")

    browser.close()
