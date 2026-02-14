"""Final platform verification - screenshot all pages"""
from playwright.sync_api import sync_playwright
import os

SCREENSHOTS_DIR = r"E:\Such_Proj\Other\EncyHub\tests\screenshots"
os.makedirs(SCREENSHOTS_DIR, exist_ok=True)

pages = [
    ("dashboard", "http://127.0.0.1:9524/"),
    ("adb_master", "http://127.0.0.1:9524/adb_master"),
    ("flow_svn", "http://127.0.0.1:9524/flow_svn"),
    ("gm_console", "http://127.0.0.1:9524/gm_console"),
]

console_errors = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})

    def on_console(msg):
        if msg.type == "error":
            console_errors.append(f"[{msg.type}] {msg.text}")

    page.on("console", on_console)

    for name, url in pages:
        try:
            page.goto(url, wait_until="networkidle", timeout=15000)
            page.wait_for_timeout(1000)
            path = os.path.join(SCREENSHOTS_DIR, f"{name}.png")
            page.screenshot(path=path, full_page=True)
            size = os.path.getsize(path)
            print(f"OK: {name} -> {path} ({size:,} bytes)")
        except Exception as e:
            print(f"FAIL: {name} -> {e}")

    browser.close()

print(f"\nConsole errors: {len(console_errors)}")
for err in console_errors[:10]:
    print(f"  {err}")
