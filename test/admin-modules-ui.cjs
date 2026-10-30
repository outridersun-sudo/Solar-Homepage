"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const express = require("express");
const { chromium } = require("playwright");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solar-admin-ui-"));
process.env.MODULE_DATA_DIR = directory;
const password = crypto.randomBytes(24).toString("hex"),
  salt = crypto.randomBytes(16).toString("hex");
process.env.ADMIN_USERNAME = "module-test";
process.env.ADMIN_PASSWORD_HASH =
  salt + ":" + crypto.scryptSync(password, salt, 64).toString("hex");
// Exercise production session/CSRF handlers; unrelated DB rate-limit storage is stubbed.
const app = express();
app.use(express.json({ limit: "100kb" }));
app.locals.security = { loginLimit: (req, res, next) => next() };
require("../server/admin")(app, {});
require("../server/calculator")(app);
app.use(express.static(path.join(__dirname, "../public")));
(async () => {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const origin = "http://127.0.0.1:" + server.address().port;
  let browser;
  try {
    assert.equal((await fetch(origin + "/api/admin/modules")).status, 401);
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1400 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin + "/admin-modules.html");
    await page.locator("#login").waitFor({ state: "visible" });
    await page.fill("#username", "module-test");
    await page.fill("#password", password);
    await page.click("#loginForm button");
    await page.locator("#management").waitFor({ state: "visible" });
    await page.waitForFunction(() =>
      document
        .querySelector("#moduleRows")
        .textContent.includes("등록 기록이 없습니다"),
    );
    const session = await (
      await page.request.get(origin + "/api/admin/session")
    ).json();
    assert.equal(
      (
        await page.request.post(origin + "/api/admin/modules", {
          headers: { Origin: origin },
          data: {},
        })
      ).status(),
      403,
    );
    assert.equal(
      (
        await page.request.post(origin + "/api/admin/modules", {
          headers: {
            Origin: "https://invalid.example",
            "X-CSRF-Token": session.csrf,
          },
          data: {},
        })
      ).status(),
      403,
    );
    const invalid = await page.request.post(
      origin + "/api/admin/modules/extract",
      {
        headers: { Origin: origin, "X-CSRF-Token": session.csrf },
        multipart: {
          file: {
            name: "fake.pdf",
            mimeType: "application/pdf",
            buffer: Buffer.from("not a pdf"),
          },
        },
      },
    );
    assert.equal(invalid.status(), 400);
    assert.equal(fs.readdirSync(path.join(directory, "documents")).length, 0);
    await page.setInputFiles(
      "#pdfFile",
      path.join(
        __dirname,
        "../public/assets/docs/HD현대_NA시리즈_데이터시트.pdf",
      ),
    );
    const extracted = page.waitForResponse(
      (r) =>
        r.url().endsWith("/modules/extract") && r.request().method() === "POST",
    );
    await page.click("#extractBtn");
    const extractedResponse = await extracted;
    assert.equal(extractedResponse.status(), 200);
    const data = await extractedResponse.json();
    await page.waitForFunction(
      () => document.querySelector("#candidate").options.length === 3,
    );
    await page.selectOption("#candidate", "2");
    assert.equal(await page.inputValue("#name"), "HiC-T645OJ");
    assert.equal(await page.inputValue("#bnpi"), "709.2");
    assert.equal(await page.inputValue("#maxV"), "1500");
    assert.equal(await page.locator("#publishBtn").isDisabled(), true);
    assert.equal(await page.locator("#replaceWrap").isVisible(), true);
    const pdfPath = "/api/admin/modules/documents/" + data.document.id + "/pdf";
    assert.equal((await page.request.get(origin + pdfPath)).status(), 200);
    assert.equal((await fetch(origin + pdfPath)).status, 401);
    assert.match(
      await page.locator("#pdfPreview").getAttribute("src"),
      /\/pages\/2/,
    );
    await page.waitForFunction(
      () =>
        document.querySelector("#pdfPreview").complete &&
        document.querySelector("#pdfPreview").naturalWidth > 0,
    );
    await page.screenshot({
      path: "/tmp/admin-modules-desktop.png",
      fullPage: true,
    });
    // Save a new model, confirm it stays private until publication.
    await page.fill("#name", "TEST-645-UI");
    await page.fill("#manufacturer", "등록 테스트");
    await page.fill("#series", "신규 시리즈");
    await page.click("#draftBtn");
    await page.waitForFunction(() =>
      document
        .querySelector("#message")
        .textContent.includes("임시 저장했습니다"),
    );
    const catalogBefore = await (
      await page.request.get(origin + "/api/calculator/catalog")
    ).json();
    assert.equal(catalogBefore.modules["등록 테스트"], undefined);
    await page.fill("#vmp", "");
    await page.check("#confirmed");
    assert.equal(await page.locator("#publishBtn").isDisabled(), true);
    await page.fill("#vmp", "46.96");
    assert.equal(await page.locator("#confirmed").isChecked(), false);
    await page.check("#confirmed");
    await page.click("#publishBtn");
    await page.waitForFunction(() =>
      document
        .querySelector("#message")
        .textContent.includes("계산기에 적용했습니다"),
    );
    const live = await (
      await page.request.get(origin + "/api/calculator/catalog")
    ).json();
    assert.equal(live.modules["등록 테스트"]["신규 시리즈"][0].vmp, 46.96);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: "/tmp/admin-modules-mobile.png",
      fullPage: true,
    });
    // Real browser loads the new catalog and requests a calculation through its worker.
    const calculator = await browser.newPage();
    await calculator.goto(origin + "/calculator.html?model=TEST-645-UI");
    await calculator.waitForFunction(() =>
      document
        .querySelector("#planComparisonBody")
        .textContent.includes("620장 / 0장"),
    );
    assert.equal(await calculator.inputValue("#manufacturer"), "등록 테스트");
    assert.equal(await calculator.inputValue("#model"), "TEST-645-UI");
    await page.getByRole("button", { name: "사용 중지", exact: true }).click();
    await page.waitForFunction(() =>
      document
        .querySelector("#message")
        .textContent.includes("사용을 중지했습니다"),
    );
    const disabled = await (
      await page.request.get(origin + "/api/calculator/catalog")
    ).json();
    assert.equal(disabled.modules["등록 테스트"], undefined);
    await page.getByRole("button", { name: "다시 적용", exact: true }).click();
    await page.waitForFunction(() =>
      document
        .querySelector("#message")
        .textContent.includes("다시 적용했습니다"),
    );
    await page.reload();
    await page.waitForFunction(() =>
      document.querySelector("#moduleRows").textContent.includes("TEST-645-UI"),
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: admin login, session/CSRF/origin checks, invalid PDF cleanup, real PDF extraction/preview, private drafts, required specs, publish-to-calculator worker, disable/enable, reload persistence, desktop/mobile UI",
    );
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
})()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
