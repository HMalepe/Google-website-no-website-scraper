// Printable lead list: one card per business with photo, contacts and links,
// grouped by business type, best leads first. Used by GET /api/report/:id/pdf.
import PDFDocument from "pdfkit";

const PAGE_MARGIN = 36;
const PHOTO = 56;
const GAP = 12;

const STATUS = {
  NO_WEBSITE: { label: "No website", color: "#0f9d8a" },
  SOCIAL_ONLY: { label: "Social only", color: "#0f9d8a" },
  FREE_SUBDOMAIN: { label: "Free subdomain", color: "#6d5efc" },
  OUTDATED_SITE: { label: "Weak website", color: "#d98a00" },
};
const PLACEHOLDER_COLORS = ["#6d5efc", "#0f9d8a", "#d98a00", "#c2416b", "#2f6fd6", "#7a8699"];

/**
 * The built-in PDF fonts only cover Latin-1. Map common typographic characters
 * and drop the rest (emoji etc.) instead of printing garbage.
 */
export function pdfText(value) {
  return String(value ?? "")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[   ]/g, " ")
    .replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function initials(name) {
  const words = pdfText(name).split(" ").filter((w) => /[a-z0-9]/i.test(w));
  return ((words[0]?.[0] || "?") + (words[1]?.[0] || "")).toUpperCase();
}

function telHref(phone) {
  const digits = String(phone || "").replace(/[^\d+]/g, "");
  return digits.replace(/\D/g, "").length >= 9 ? `tel:${digits}` : null;
}

function safeHttp(url) {
  const v = String(url || "").trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(v)) return `https://${v}`;
  return null;
}

/** Group by the business type searched for (else Google's category), biggest first. */
export function groupLeads(leads) {
  const groups = new Map();
  for (const lead of leads) {
    const type = pdfText(lead.search_type || lead.category) || "Other";
    const key = type.charAt(0).toUpperCase() + type.slice(1);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(lead);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => Number(b.score || 0) - Number(a.score || 0) ||
      Number(b.review_count || 0) - Number(a.review_count || 0));
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

/**
 * @param {object} opts
 * @param {object[]} opts.leads      rows from leads.csv
 * @param {string}   opts.title      e.g. "Leads - Johannesburg"
 * @param {string}   opts.subtitle   e.g. "Scanned 9 Oct 2026 · Randburg, Sandton"
 * @param {(url: string) => Promise<Buffer|null>} [opts.fetchImage]  JPEG/PNG bytes or null
 * @returns {Promise<Buffer>}
 */
export async function buildLeadsPdf({ leads, title, subtitle, fetchImage }) {
  const photos = new Map();
  if (fetchImage) {
    const urls = [...new Set(leads.map((l) => l.thumbnail).filter(Boolean))].slice(0, 300);
    let next = 0;
    const worker = async () => {
      while (next < urls.length) {
        const url = urls[next++];
        photos.set(url, await fetchImage(url).catch(() => null));
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  const doc = new PDFDocument({
    size: "A4",
    margin: PAGE_MARGIN,
    bufferPages: true,
    info: { Title: pdfText(title), Creator: "Selantra WebScrape" },
  });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const left = PAGE_MARGIN;
  const right = doc.page.width - PAGE_MARGIN;
  const width = right - left;
  const bottom = () => doc.page.height - PAGE_MARGIN - 18; // room for the footer

  // ---- Header
  doc.font("Helvetica-Bold").fontSize(20).fillColor("#111827").text(pdfText(title), left, PAGE_MARGIN);
  doc.font("Helvetica").fontSize(10).fillColor("#6b7280").text(pdfText(subtitle), { width });
  const counts = {};
  for (const l of leads) counts[l.status || "NO_WEBSITE"] = (counts[l.status || "NO_WEBSITE"] || 0) + 1;
  const countLine = Object.entries(counts)
    .map(([s, n]) => `${STATUS[s]?.label || s}: ${n}`)
    .join("   ·   ");
  doc.moveDown(0.3).fontSize(10).fillColor("#374151")
    .text(`${leads.length} businesses   ·   ${pdfText(countLine)}`, { width });
  doc.moveDown(0.8);

  if (!leads.length) {
    doc.fontSize(12).fillColor("#374151").text("No leads with contact details in this scan.");
  }

  // ---- Cards
  const textX = left + PHOTO + GAP;
  const textW = right - textX;
  const labelW = 62;

  const rowsFor = (lead) => {
    const rows = [];
    if (lead.phone) rows.push(["Phone", pdfText(lead.phone), telHref(lead.phone), true]);
    if (lead.whatsapp) rows.push(["WhatsApp", "Message on WhatsApp", safeHttp(lead.whatsapp)]);
    if (lead.email) {
      const first = pdfText(lead.email).split(/[;,\s]+/)[0];
      rows.push(["Email", pdfText(lead.email), first ? `mailto:${first}` : null, true]);
    }
    const address = lead.address || lead.location;
    if (address) rows.push(["Address", pdfText(address)]);
    if (lead.website && lead.has_website === "yes") rows.push(["Website", pdfText(lead.website), safeHttp(lead.website)]);
    if (lead.google_maps_link) rows.push(["Maps", "Open in Google Maps", safeHttp(lead.google_maps_link)]);
    return rows;
  };

  const cardHeight = (lead) => {
    doc.font("Helvetica-Bold").fontSize(12);
    let h = doc.heightOfString(pdfText(lead.business_name) || "-", { width: textW - 110 }) + 4;
    doc.font("Helvetica").fontSize(9);
    h += 14; // rating / type line
    for (const [, value] of rowsFor(lead)) {
      h += Math.max(13, doc.heightOfString(value, { width: textW - labelW }) + 3);
    }
    if (lead.reasons && lead.status !== "NO_WEBSITE") {
      h += doc.heightOfString(`Why: ${pdfText(lead.reasons)}`, { width: textW }) + 4;
    }
    return Math.max(h, PHOTO) + 18;
  };

  let index = 0;
  for (const [category, list] of groupLeads(leads)) {
    if (doc.y + 30 + cardHeight(list[0]) > bottom()) doc.addPage();
    const headY = doc.y;
    doc.rect(left, headY, width, 22).fill("#eef0ff");
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#3730a3")
      .text(`${category}  (${list.length})`, left + 10, headY + 6, { width: width - 20 });
    doc.y = headY + 30;

    for (const lead of list) {
      index++;
      const h = cardHeight(lead);
      if (doc.y + h > bottom()) doc.addPage();
      const top = doc.y;

      // Photo, or coloured initials when there is none.
      const image = lead.thumbnail ? photos.get(lead.thumbnail) : null;
      let drewPhoto = false;
      if (image) {
        try {
          doc.save();
          doc.roundedRect(left, top, PHOTO, PHOTO, 8).clip();
          doc.image(image, left, top, { cover: [PHOTO, PHOTO], align: "center", valign: "center" });
          doc.restore();
          drewPhoto = true;
        } catch {
          doc.restore();
        }
      }
      if (!drewPhoto) {
        const color = PLACEHOLDER_COLORS[(index - 1) % PLACEHOLDER_COLORS.length];
        doc.roundedRect(left, top, PHOTO, PHOTO, 8).fill(color);
        doc.font("Helvetica-Bold").fontSize(18).fillColor("#ffffff")
          .text(initials(lead.business_name), left, top + PHOTO / 2 - 9, { width: PHOTO, align: "center" });
      }

      // Name + lead badge
      const status = STATUS[lead.status] || STATUS.NO_WEBSITE;
      const badge = `${status.label}${lead.score ? ` · ${lead.score}` : ""}`;
      doc.font("Helvetica-Bold").fontSize(8);
      const badgeW = doc.widthOfString(badge) + 12;
      doc.roundedRect(right - badgeW, top, badgeW, 15, 7).fill(status.color);
      doc.fillColor("#ffffff").text(badge, right - badgeW, top + 4, { width: badgeW, align: "center" });

      doc.font("Helvetica-Bold").fontSize(12).fillColor("#111827")
        .text(`${index}. ${pdfText(lead.business_name) || "-"}`, textX, top, { width: textW - badgeW - 10 });

      const rating = lead.review_rating ? `Rating ${Number(lead.review_rating).toFixed(1)}` : "No rating";
      const reviews = lead.review_count ? ` (${lead.review_count} reviews)` : "";
      const meta = [`${rating}${reviews}`, pdfText(lead.category), pdfText(lead.area)].filter(Boolean);
      doc.font("Helvetica").fontSize(9).fillColor("#6b7280")
        .text(meta.join("   ·   "), textX, doc.y + 2, { width: textW });
      doc.y += 3;

      for (const [label, value, link, strong] of rowsFor(lead)) {
        const y = doc.y;
        doc.font("Helvetica").fontSize(8).fillColor("#9ca3af").text(label.toUpperCase(), textX, y + 1, { width: labelW });
        doc.font(strong ? "Helvetica-Bold" : "Helvetica").fontSize(9.5)
          .fillColor(link ? "#2f4fd6" : "#1f2937")
          .text(value, textX + labelW, y, { width: textW - labelW, link: link || undefined, underline: Boolean(link) && !strong });
        doc.y = Math.max(doc.y, y + 13);
      }
      if (lead.reasons && lead.status !== "NO_WEBSITE") {
        doc.font("Helvetica-Oblique").fontSize(8.5).fillColor("#6b7280")
          .text(`Why: ${pdfText(lead.reasons)}`, textX, doc.y + 2, { width: textW });
      }

      const end = Math.max(doc.y, top + PHOTO) + 8;
      doc.moveTo(left, end).lineTo(right, end).lineWidth(0.5).strokeColor("#e5e7eb").stroke();
      doc.y = end + 10;
    }
    doc.y += 4;
  }

  // ---- Footer with page numbers
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // writing below the margin would otherwise add a page
    doc.font("Helvetica").fontSize(8).fillColor("#9ca3af").text(
      `Selantra WebScrape   ·   Page ${i + 1} of ${range.count}`,
      left,
      doc.page.height - PAGE_MARGIN,
      { width, align: "center", lineBreak: false }
    );
  }

  doc.end();
  return done;
}
