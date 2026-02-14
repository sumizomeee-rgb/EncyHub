"""Verify CSS layer fix and nested button fix"""
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
    page.screenshot(path=os.path.join(SCREENSHOTS_DIR, "fix_dashboard.png"), full_page=True)

    # Check padding on p-* elements
    p_els = page.locator("[class*='p-']").all()
    print(f"Elements with p-* class: {len(p_els)}")
    for i, el in enumerate(p_els[:5]):
        padding = el.evaluate("el => getComputedStyle(el).padding")
        cls = el.evaluate("el => el.className")
        tag = el.evaluate("el => el.tagName")
        print(f"  [{tag}] padding={padding}, class={cls[:80]}")

    # Check p-6 specifically
    p6_els = page.locator("[class*='p-6']").all()
    print(f"\nElements with p-6: {len(p6_els)}")
    for i, el in enumerate(p6_els[:5]):
        padding = el.evaluate("el => getComputedStyle(el).padding")
        print(f"  p-6 element {i}: padding={padding}")

    # Check px-6
    px6_els = page.locator("[class*='px-6']").all()
    print(f"\nElements with px-6: {len(px6_els)}")
    for i, el in enumerate(px6_els[:3]):
        padding = el.evaluate("el => getComputedStyle(el).paddingLeft + ' / ' + getComputedStyle(el).paddingRight")
        print(f"  px-6 element {i}: paddingLR={padding}")

    # ADB Master
    page.goto("http://127.0.0.1:9524/adb_master", wait_until="networkidle", timeout=15000)
    page.wait_for_timeout(1500)
    page.screenshot(path=os.path.join(SCREENSHOTS_DIR, "fix_adbmaster.png"), full_page=True)

    # Check nested buttons
    nested = page.evaluate("""() => {
        const buttons = document.querySelectorAll('button button');
        return buttons.length;
    }""")
    print(f"\nNested buttons (should be 0): {nested}")

    # Check logcat header is now a div
    logcat_divs = page.locator("div[role='button']").all()
    print(f"div[role=button] elements: {len(logcat_divs)}")

    # FlowSVN
    page.goto("http://127.0.0.1:9524/flow_svn", wait_until="networkidle", timeout=15000)
    page.wait_for_timeout(1000)
    page.screenshot(path=os.path.join(SCREENSHOTS_DIR, "fix_flowsvn.png"), full_page=True)

    # GmConsole
    page.goto("http://127.0.0.1:9524/gm_console", wait_until="networkidle", timeout=15000)
    page.wait_for_timeout(1000)
    page.screenshot(path=os.path.join(SCREENSHOTS_DIR, "fix_gmconsole.png"), full_page=True)

    print(f"\nConsole errors: {len(errors)}")
    for e in errors[:5]:
        print(f"  {e}")

    print("\nDone - check screenshots in tests/screenshots/fix_*.png")
    browser.close()
