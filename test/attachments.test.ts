import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFileSync } from "node:fs"
import { strToU8, zipSync } from "fflate"
import { extractAttachmentText, sanitizeText } from "../src/attachments"

setDefaultTimeout(20_000)

const extract = (filename: string, contentType: string, data: Uint8Array, maxChars = 100_000, signal?: AbortSignal) =>
  extractAttachmentText({ filename, contentType, data, maxChars, ...(signal ? { signal } : {}) })

const docx = (body: string): Uint8Array =>
  zipSync({
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ),
  })

const xlsx = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)])))

const buildPdf = (text: string): Uint8Array => buildPdfPages([text])

const buildPdfPages = (texts: string[]): Uint8Array => {
  const objects: Array<string | null> = []
  objects.push("<< /Type /Catalog /Pages 2 0 R >>")
  const pageIds = texts.map((_, index) => 3 + index)
  const contentIds = texts.map((_, index) => 3 + texts.length + index)
  const fontId = 3 + texts.length * 2
  objects.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${texts.length} >>`)
  for (const id of pageIds) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[pageIds.indexOf(id)]} 0 R >>`,
    )
  }
  for (const text of texts) {
    const stream = `BT /F1 10 Tf 20 100 Td (${text}) Tj ET`
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

  const parts: string[] = ["%PDF-1.4\n"]
  const offsets: number[] = [0]
  let position = parts[0].length
  objects.forEach((body, index) => {
    offsets.push(position)
    const chunk = `${index + 1} 0 obj\n${body}\nendobj\n`
    parts.push(chunk)
    position += Buffer.byteLength(chunk)
  })
  const xref = [`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n"]
  for (let index = 1; index <= objects.length; index++) {
    xref.push(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`)
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`
  return new Uint8Array(Buffer.from(parts.join("") + xref.join("") + trailer, "latin1"))
}

describe("Word (.docx)", () => {
  test("extracts paragraphs, tabs and table cells", async () => {
    const data = docx(
      "<w:p><w:r><w:t>Hello &amp; world</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>Second</w:t></w:r><w:r><w:tab/><w:t>tabbed</w:t></w:r></w:p>" +
        "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>",
    )
    const result = await extract(
      "report.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      data,
    )
    expect(result.kind).toBe("word")
    expect(result.text).toContain("Hello & world")
    expect(result.text).toContain("Second\ttabbed")
    expect(result.text).toContain("A1")
    expect(result.text).toContain("B1")
    expect(result.text).toContain("A1\tB1\n")
    expect(result.text).not.toContain("B1\t")
    expect(result.truncated).toBe(false)
  })

  test("does not turn tab-stop definitions into text", async () => {
    const data = docx(
      '<w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="9350"/></w:tabs></w:pPr><w:r><w:t>Line1</w:t><w:tab/><w:t>Line2</w:t></w:r></w:p>',
    )
    const result = await extract("tabs.docx", "", data)
    expect(result.text).toBe("Line1\tLine2\n")
  })

  test("keeps the paragraph break before a tab-stop definition", async () => {
    const data = docx(
      "<w:p><w:r><w:t>Line1</w:t></w:r></w:p>" +
        '<w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="9350"/></w:tabs></w:pPr><w:r><w:t>Line2</w:t></w:r></w:p>',
    )
    const result = await extract("tabstops.docx", "", data)
    expect(result.text).toBe("Line1\nLine2\n")
  })

  test("ignores foreign namespaces", async () => {
    const data = docx(
      '<w:p><w:r><foo:t xmlns:foo="urn:foreign">FOREIGN</foo:t><w:t>Real</w:t></w:r></w:p>' +
        '<w:p><w:r><a:t xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">DRAWING</a:t></w:r></w:p>',
    )
    const result = await extract("foreign.docx", "", data)
    expect(result.text).toBe("Real\n\n")
  })

  test("extracts the VML fallback when the choice has no text", async () => {
    const data = docx(
      '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
        '<mc:Choice Requires="wps"><w:drawing><a:t>Hello</a:t></w:drawing></mc:Choice>' +
        "<mc:Fallback><w:p><w:r><w:t>FallbackOnly</w:t></w:r></w:p></mc:Fallback>" +
        "</mc:AlternateContent>",
    )
    const result = await extract("fallback.docx", "", data)
    expect(result.text).toBe("FallbackOnly\n")
  })

  test("does not duplicate text present in both alternate branches", async () => {
    const data = docx(
      '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
        "<mc:Choice><w:p><w:r><w:t>Both</w:t></w:r></w:p></mc:Choice>" +
        "<mc:Fallback><w:p><w:r><w:t>Both</w:t></w:r></w:p></mc:Fallback>" +
        "</mc:AlternateContent>",
    )
    const result = await extract("alternates.docx", "", data)
    expect(result.text).toBe("Both\n")
  })

  test("keeps text from only one choice branch", async () => {
    const data = docx(
      '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
        '<mc:Choice Requires="a"><w:p><w:r><w:t>DUPTEXT</w:t></w:r></w:p></mc:Choice>' +
        '<mc:Choice Requires="b"><w:p><w:r><w:t>DUPTEXT</w:t></w:r></w:p></mc:Choice>' +
        "</mc:AlternateContent>",
    )
    const result = await extract("twochoices.docx", "", data)
    expect(result.text).toBe("DUPTEXT\n")
  })

  test("reads a later choice when the first one has no text", async () => {
    const data = docx(
      '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
        '<mc:Choice Requires="a"><w:drawing/></mc:Choice>' +
        '<mc:Choice Requires="b"><w:p><w:r><w:t>SECOND</w:t></w:r></w:p></mc:Choice>' +
        "</mc:AlternateContent>",
    )
    const result = await extract("secondchoice.docx", "", data)
    expect(result.text).toBe("SECOND\n")
  })

  test("does not let a later empty choice re-enable the fallback", async () => {
    const data = docx(
      '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
        '<mc:Choice Requires="a"><w:p><w:r><w:t>First</w:t></w:r></w:p></mc:Choice>' +
        '<mc:Choice Requires="b"><w:drawing/></mc:Choice>' +
        "<mc:Fallback><w:p><w:r><w:t>First</w:t></w:r></w:p></mc:Fallback>" +
        "</mc:AlternateContent>",
    )
    const result = await extract("multichoice.docx", "", data)
    expect(result.text).toBe("First\n")
  })

  test("does not treat whitespace-only choice content as text", async () => {
    const data = docx(
      '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
        '<mc:Choice Requires="a"><w:p><w:r><w:t>   </w:t></w:r></w:p></mc:Choice>' +
        '<mc:Choice Requires="b"><w:p><w:r><w:t>REALTEXT</w:t></w:r></w:p></mc:Choice>' +
        "</mc:AlternateContent>",
    )
    const result = await extract("whitespacechoice.docx", "", data)
    expect(result.text).toBe("REALTEXT\n")
  })

  test("does not treat an invisible-format choice as text", async () => {
    const data = docx(
      '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
        '<mc:Choice Requires="a"><w:p><w:r><w:t>\u200b</w:t></w:r></w:p></mc:Choice>' +
        "<mc:Fallback><w:p><w:r><w:t>FBTEXT</w:t></w:r></w:p></mc:Fallback>" +
        "</mc:AlternateContent>",
    )
    const result = await extract("invisiblechoice.docx", "", data)
    expect(result.text).toBe("FBTEXT\n")
  })

  test("does not treat an empty paragraph choice as text", async () => {
    const data = docx(
      '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
        '<mc:Choice Requires="a"><w:p/></mc:Choice>' +
        "<mc:Fallback><w:p><w:r><w:t>FBTEXT</w:t></w:r></w:p></mc:Fallback>" +
        "</mc:AlternateContent>",
    )
    const result = await extract("emptychoice.docx", "", data)
    expect(result.text).toBe("FBTEXT\n")
  })

  test("strips C1 controls and bidi overrides", () => {
    expect(sanitizeText("a\u0085b\u009bc\u202ed")).toBe("abcd")
  })

  test("keeps CDATA content", async () => {
    const data = docx("<w:p><w:r><w:t>a<![CDATA[b&c]]>d</w:t></w:r></w:p>")
    const result = await extract("cdata.docx", "", data)
    expect(result.text).toBe("ab&cd\n")
  })

  test("ignores an element that resets the namespace to empty", async () => {
    const data = docx('<w:p><w:r><t xmlns="">OUT</t><w:t>IN</w:t></w:r></w:p>')
    const result = await extract("nsreset.docx", "", data)
    expect(result.text).toBe("IN\n")
  })

  test("decodes numeric XML entities", async () => {
    const data = docx("<w:p><w:r><w:t>&#65;&#x42;</w:t></w:r></w:p>")
    const result = await extract("entities.docx", "", data)
    expect(result.text).toContain("AB")
  })

  test("decodes OOXML _x000D_ line breaks", async () => {
    const data = docx("<w:p><w:r><w:t>a_x000D_b</w:t></w:r></w:p>")
    const result = await extract("breaks.docx", "", data)
    expect(result.text).toContain("a\nb")
  })

  test("explains an empty document without mentioning OCR", async () => {
    const data = docx("<w:p/>")
    const result = await extract("empty.docx", "", data)
    expect(result.text).toBe("")
    expect(result.note).toContain("No extractable text")
    expect(result.note).not.toContain("OCR")
  })

  test("truncates long document text and marks it", async () => {
    const data = docx(`<w:p><w:r><w:t>${"a".repeat(10_000)}</w:t></w:r></w:p>`)
    const result = await extract("long.docx", "", data, 1_000)
    expect(result.text).toHaveLength(1_000)
    expect(result.truncated).toBe(true)
  })

  test("rejects a forged ZIP uncompressed size", async () => {
    const body = Array.from({ length: 41 }, (_, index) => `<w:p><w:r><w:t>PARA${index}</w:t></w:r></w:p>`).join("")
    const data = Buffer.from(docx(body))
    for (let index = 0; index < data.length - 4; index++) {
      if (data.readUInt32LE(index) === 0x02014b50) {
        data.writeUInt32LE(200, index + 24)
        break
      }
    }
    await expect(extract("forged.docx", "", new Uint8Array(data))).rejects.toThrow(/too many bytes|unpack|invalid/)
  })

  test("recognises a non-w namespace prefix and a default namespace", async () => {
    const prefixed =
      '<x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:body><x:p><x:r><x:t>Hi</x:t></x:r></x:p></x:body></x:document>'
    const prefixedData = zipSync({ "word/document.xml": strToU8(prefixed) })
    expect((await extract("prefix.docx", "", prefixedData)).text).toContain("Hi")
    const defaultNs =
      '<document xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><body><p><r><t>Hello</t></r></p></body></document>'
    const defaultData = zipSync({ "word/document.xml": strToU8(defaultNs) })
    expect((await extract("default.docx", "", defaultData)).text).toContain("Hello")
  })

  test("rejects a zip without word/document.xml", async () => {
    const data = zipSync({ "word/other.xml": strToU8("<x/>") })
    await expect(extract("broken.docx", "", data)).rejects.toThrow(/missing word\/document\.xml/)
  })

  test("rejects a corrupt zip", async () => {
    await expect(extract("broken.docx", "", new Uint8Array([1, 2, 3]))).rejects.toThrow(/cannot unpack attachment/)
  })

  test("rejects hostile OOXML without quadratic parsing", async () => {
    const data = docx("<w:t".repeat(100_000))
    await expect(extract("hostile.docx", "", data)).rejects.toThrow(/invalid OOXML XML/)
  }, 3_000)

  test("normalizes hostile whitespace without quadratic backtracking", async () => {
    const data = docx(`<w:p><w:r><w:t>${" ".repeat(410_000)}</w:t></w:r></w:p>`)
    const result = await extract("whitespace.docx", "", data)
    expect(result.truncated).toBe(true)
  }, 3_000)

  test("rejects XML nesting beyond the depth limit", async () => {
    const data = docx(`${"<w:a>".repeat(300)}${"</w:a>".repeat(300)}`)
    await expect(extract("deep.docx", "", data)).rejects.toThrow(/nesting is too deep/)
  })

  test("rejects an oversized OOXML part before decompressing it", async () => {
    const data = zipSync({ "word/document.xml": new Uint8Array(33 * 1024 * 1024) })
    await expect(extract("big.docx", "", data)).rejects.toThrow(/part is too large/)
  })
})

describe("Excel (.xlsx)", () => {
  const workbook = (): Uint8Array =>
    xlsx({
      "xl/workbook.xml":
        '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Second" sheetId="2" r:id="rId2"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet2.xml"/><Relationship Id="rId2" Target="worksheets/sheet1.xml"/></Relationships>',
      "xl/sharedStrings.xml":
        '<sst><si><t>Name</t></si><si><t>Value &amp; More</t></si><si><r><t>Rich</t></r><r><t>Text</t></r></si><si><t>Kanji</t><rPh sb="0" eb="5"><t>かんじ</t></rPh></si></sst>',
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42.5</v></c><c r="D2" t="inlineStr"><is><t>Inline</t></is></c><c r="E2" t="b"><v>1</v></c><c r="F2" t="s"><v>3</v></c></row></sheetData></worksheet>',
      "xl/worksheets/sheet2.xml":
        '<worksheet><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>',
    })

  test("extracts shared strings, inline strings, numbers, booleans and sheet names", async () => {
    const result = await extract(
      "book.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      workbook(),
    )
    expect(result.kind).toBe("excel")
    expect(result.sheets).toEqual(["Data", "Second"])
    expect(result.text).toContain("### Sheet: Data")
    expect(result.text).toContain("Name\tValue & More")
    expect(result.text).toContain("RichText\t42.5\t\tInline\tTRUE")
    expect(result.text).toContain("Kanji")
    expect(result.text).not.toContain("かんじ")
    expect(result.text).toContain("### Sheet: Second")
    expect(result.text).toContain("7")
    expect(result.truncated).toBe(false)
  })

  test("rejects a workbook whose total extracted size exceeds the cap", async () => {
    const chunk = new Uint8Array(25 * 1024 * 1024)
    const data = zipSync({
      "xl/workbook.xml": strToU8("<workbook/>"),
      "xl/worksheets/sheet1.xml": chunk,
      "xl/worksheets/sheet2.xml": chunk,
      "xl/worksheets/sheet3.xml": chunk,
    })
    await expect(extract("total.xlsx", "", data)).rejects.toThrow(/too large/)
  }, 20_000)

  test("rejects a workbook with too many ZIP entries", async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 1_001; index++) files[`xl/worksheets/sheet${index + 1}.xml`] = "<worksheet/>"
    await expect(extract("many.xlsx", "", xlsx(files))).rejects.toThrow(/too many ZIP entries/)
  })

  test("rejects a workbook without worksheets", async () => {
    await expect(extract("empty.xlsx", "", xlsx({ "xl/workbook.xml": "<workbook/>" }))).rejects.toThrow(/no worksheets/)
  })

  test("keeps later rows when a cell is beyond the column cap and notes the columns", async () => {
    const result = await extract(
      "wide.xlsx",
      "",
      xlsx({
        "xl/workbook.xml":
          '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" r:id="rId1"/></sheets></workbook>',
        "xl/worksheets/sheet1.xml":
          '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row>' +
          '<row r="2"><c r="ZZZ2"><v>9</v></c></row>' +
          '<row r="3"><c r="A3"><v>3</v></c></row></sheetData></worksheet>',
      }),
    )
    expect(result.text).toContain("3")
    expect(result.note).toContain("Columns beyond 1000")
  })

  test("decodes a UTF-16 worksheet", async () => {
    const sheet = '<worksheet><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>'
    const utf16 = new Uint8Array([0xff, 0xfe, ...new Uint8Array(Buffer.from(sheet, "utf16le"))])
    const data = zipSync({
      "xl/workbook.xml": strToU8("<workbook/>"),
      "xl/worksheets/sheet1.xml": utf16,
    })
    const result = await extract("utf16.xlsx", "", data)
    expect(result.text).toContain("7")
  })

  test("keeps sheet names from a prefixed workbook", async () => {
    const result = await extract(
      "prefixed.xlsx",
      "",
      xlsx({
        "xl/workbook.xml":
          '<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheets><x:sheet name="Data" r:id="rId1"/></x:sheets></x:workbook>',
        "xl/_rels/workbook.xml.rels":
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml":
          '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row><x:c><x:v>7</x:v></x:c></x:row></x:sheetData></x:worksheet>',
      }),
    )
    expect(result.sheets).toEqual(["Data"])
    expect(result.text).toContain("7")
  })

  test("ignores spreadsheet elements from a foreign namespace", async () => {
    const result = await extract(
      "x14.xlsx",
      "",
      xlsx({
        "xl/worksheets/sheet1.xml":
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><sheetData><row><c><v>1</v></c><x14:c><x14:v>999</x14:v></x14:c></row></sheetData></worksheet>',
      }),
    )
    expect(result.text).toContain("1")
    expect(result.text).not.toContain("999")
  })

  test("maps strict-OOXML relationships to sheet names", async () => {
    const result = await extract(
      "strict.xlsx",
      "",
      xlsx({
        "xl/workbook.xml":
          '<x:workbook xmlns:x="http://purl.oclc.org/ooxml/spreadsheetml/main" xmlns:r="http://purl.oclc.org/ooxml/officeDocument/relationships"><x:sheets><x:sheet name="Second" r:id="rId1"/><x:sheet name="First" r:id="rId2"/></x:sheets></x:workbook>',
        "xl/_rels/workbook.xml.rels":
          '<Relationships xmlns="http://purl.oclc.org/ooxml/package/relationships"><Relationship Id="rId1" Target="worksheets/sheet2.xml"/><Relationship Id="rId2" Target="worksheets/sheet1.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml":
          '<x:worksheet xmlns:x="http://purl.oclc.org/ooxml/spreadsheetml/main"><x:sheetData><x:row><x:c><x:v>1</x:v></x:c></x:row></x:sheetData></x:worksheet>',
        "xl/worksheets/sheet2.xml":
          '<x:worksheet xmlns:x="http://purl.oclc.org/ooxml/spreadsheetml/main"><x:sheetData><x:row><x:c><x:v>2</x:v></x:c></x:row></x:sheetData></x:worksheet>',
      }),
    )
    expect(result.sheets).toEqual(["Second", "First"])
    expect(result.text).toContain("### Sheet: Second\n2")
    expect(result.text).toContain("### Sheet: First\n1")
  })

  test("reads prefixed attributes on a prefixed worksheet", async () => {
    const result = await extract(
      "prefixattr.xlsx",
      "",
      xlsx({
        "xl/workbook.xml":
          '<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheets><x:sheet x:name="Data" r:id="rId1"/></x:sheets></x:workbook>',
        "xl/_rels/workbook.xml.rels":
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml":
          '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row><x:c x:r="C3" x:t="inlineStr"><x:is><x:t>PFXATTR</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>',
      }),
    )
    expect(result.sheets).toEqual(["Data"])
    expect(result.text).toContain("PFXATTR")
  })

  test("extracts a single worksheet by name or index", async () => {
    const data = xlsx({
      "xl/workbook.xml": '<workbook><sheets><sheet name="First"/><sheet name="Second"/></sheets></workbook>',
      "xl/worksheets/sheet1.xml": "<worksheet><sheetData><row><c><v>111</v></c></row></sheetData></worksheet>",
      "xl/worksheets/sheet2.xml": "<worksheet><sheetData><row><c><v>222</v></c></row></sheetData></worksheet>",
    })
    const byName = await extractAttachmentText({
      filename: "book.xlsx",
      contentType: "",
      data,
      maxChars: 100_000,
      sheet: "Second",
    })
    expect(byName.sheets).toEqual(["Second"])
    expect(byName.text).toContain("222")
    expect(byName.text).not.toContain("111")
    const byIndex = await extractAttachmentText({
      filename: "book.xlsx",
      contentType: "",
      data,
      maxChars: 100_000,
      sheet: "2",
    })
    expect(byIndex.text).toContain("222")
    await expect(
      extractAttachmentText({ filename: "book.xlsx", contentType: "", data, maxChars: 100_000, sheet: "Missing" }),
    ).rejects.toThrow(/sheet not found: Missing \(available: First, Second\)/)
  })

  test("prefers an exact numeric sheet name over a 1-based index", async () => {
    const data = xlsx({
      "xl/workbook.xml": '<workbook><sheets><sheet name="X"/><sheet name="Y"/><sheet name="2"/></sheets></workbook>',
      "xl/worksheets/sheet1.xml": "<worksheet><sheetData><row><c><v>111</v></c></row></sheetData></worksheet>",
      "xl/worksheets/sheet2.xml": "<worksheet><sheetData><row><c><v>222</v></c></row></sheetData></worksheet>",
      "xl/worksheets/sheet3.xml": "<worksheet><sheetData><row><c><v>333</v></c></row></sheetData></worksheet>",
    })
    const result = await extractAttachmentText({
      filename: "numeric.xlsx",
      contentType: "",
      data,
      maxChars: 100_000,
      sheet: "2",
    })
    expect(result.sheets).toEqual(["2"])
    expect(result.text).toContain("333")
  })

  test("reads columns beyond the old 200-column limit", async () => {
    const data = xlsx({
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row><c r="A1"><v>1</v></c><c r="ZZ1"><v>9</v></c></row></sheetData></worksheet>',
    })
    const result = await extract("wide.xlsx", "", data)
    expect(result.text).toContain("1")
    expect(result.text).toContain("9")
    expect(result.note ?? "").not.toContain("Columns beyond")
  })
})

describe("PDF", () => {
  test("extracts text and page count", async () => {
    const result = await extract("doc.pdf", "application/pdf", buildPdf("Hello PDF"))
    expect(result.kind).toBe("pdf")
    expect(result.pages).toBe(1)
    expect(result.text).toContain("Hello PDF")
    expect(result.truncated).toBe(false)
  })

  test("truncates PDFs above 200 pages", async () => {
    const result = await extract(
      "many.pdf",
      "application/pdf",
      buildPdfPages(Array.from({ length: 201 }, (_, index) => `Page ${index + 1}`)),
    )
    expect(result.kind).toBe("pdf")
    expect(result.pages).toBe(201)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain("Page 1")
    expect(result.text).toContain("Page 200")
    expect(result.text).not.toContain("Page 201")
  }, 20_000)

  test("keeps reading after an empty first page", async () => {
    const texts = ["", ...Array.from({ length: 200 }, (_, index) => `Body ${index + 2}`)]
    const result = await extract("cover.pdf", "application/pdf", buildPdfPages(texts))
    expect(result.pages).toBe(201)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain("Body 2")
    expect(result.text).toContain("Body 200")
  }, 20_000)

  test("rejects a non-PDF payload", async () => {
    await expect(extract("broken.pdf", "application/pdf", new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(
      /cannot read PDF/,
    )
  })
})

describe("Legacy binary Word/Excel", () => {
  test("extracts text from .doc", async () => {
    const data = new Uint8Array(readFileSync(new URL("./fixtures/word-doc/test01.doc", import.meta.url)))
    const result = await extract("legacy.doc", "application/msword", data)
    expect(result.kind).toBe("word")
    expect(result.text).toContain("This is a test of reviewing")
    expect(result.truncated).toBe(false)
  })

  test("rejects a corrupt .doc", async () => {
    await expect(extract("broken.doc", "application/msword", new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /cannot read legacy Word/,
    )
  })

  test("extracts shared values from .xls", async () => {
    const XLSX = await import("@e965/xlsx")
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Name", "Value"],
        ["Alpha", 42],
        ["Beta", true],
      ]),
      "Data",
    )
    const data = new Uint8Array(XLSX.write(workbook, { bookType: "xls", type: "buffer" }) as Buffer)
    const result = await extract("legacy.xls", "application/vnd.ms-excel", data)
    expect(result.kind).toBe("excel")
    expect(result.sheets).toEqual(["Data"])
    expect(result.text).toContain("Name\tValue")
    expect(result.text).toContain("Alpha\t42")
    expect(result.text).toContain("Beta\tTRUE")
  })

  test("extracts a single sheet from .xls by name", async () => {
    const XLSX = await import("@e965/xlsx")
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["first"]]), "First")
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["second"]]), "Second")
    const data = new Uint8Array(XLSX.write(workbook, { bookType: "xls", type: "buffer" }) as Buffer)
    const result = await extractAttachmentText({
      filename: "legacy.xls",
      contentType: "application/vnd.ms-excel",
      data,
      maxChars: 100_000,
      sheet: "Second",
    })
    expect(result.sheets).toEqual(["Second"])
    expect(result.text).toContain("second")
    expect(result.text).not.toContain("first")
    await expect(
      extractAttachmentText({
        filename: "legacy.xls",
        contentType: "application/vnd.ms-excel",
        data,
        maxChars: 100_000,
        sheet: "Nope",
      }),
    ).rejects.toThrow(/^sheet not found: Nope/)
  })

  test("rejects a corrupt .xls", async () => {
    await expect(extract("broken.xls", "application/vnd.ms-excel", new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /cannot read legacy Excel/,
    )
  })

  test("reads a UTF-16 CSV file with an .xls extension as text", async () => {
    const csv = "a,b\n1,2"
    const data = new Uint8Array([0xff, 0xfe, ...new Uint8Array(Buffer.from(csv, "utf16le"))])
    const result = await extract("table16.xls", "application/vnd.ms-excel", data)
    expect(result.kind).toBe("text")
    expect(result.text).toContain("a,b")
  })

  test("reads a CSV/HTML file with an .xls extension as text", async () => {
    const result = await extract("table.xls", "application/vnd.ms-excel; charset=utf-8", strToU8("a,b\n1,2"))
    expect(result.kind).toBe("text")
    expect(result.text).toContain("a,b")
    expect(result.note).toContain(".xls extension")
  })
})

describe("plain text and limits", () => {
  test("decodes UTF-8 and normalizes CRLF", async () => {
    const result = await extract("notes.txt", "text/plain", strToU8("line1\r\nline2"))
    expect(result.kind).toBe("text")
    expect(result.text).toBe("line1\nline2")
  })

  test("decodes UTF-16LE with a BOM", async () => {
    const payload = new Uint8Array([0xff, 0xfe, ...new Uint8Array(Buffer.from("Hello", "utf16le"))])
    const result = await extract("notes.txt", "text/plain", payload)
    expect(result.text).toBe("Hello")
  })

  test("honours the declared legacy charset", async () => {
    const payload = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2])
    const result = await extract("notes.txt", "text/plain; charset=windows-1251", payload)
    expect(result.text).toBe("Привет")
  })

  test("truncates by characters and clamps maxChars", async () => {
    const result = await extract("long.txt", "text/plain", strToU8("a".repeat(1500)), 10)
    expect(result.text).toHaveLength(1000)
    expect(result.truncated).toBe(true)
  })

  test("reports an over-limit attachment with an honest size", async () => {
    const data = new Uint8Array(20 * 1024 * 1024 + 1)
    await expect(extract("big.txt", "text/plain", data)).rejects.toThrow(/21 MB \(max 20 MB\)/)
  })

  test("honours an already aborted signal", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(extract("notes.txt", "text/plain", strToU8("text"), 1_000, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    })
  })

  test("sanitizes unsupported content types in errors", async () => {
    const nasty = `application/octet-stream\u001b[31m${"x".repeat(5_000)}`
    let caught: Error | undefined
    try {
      await extract("image.bin", nasty, strToU8("x"))
    } catch (error) {
      caught = error as Error
    }
    expect(caught).toBeDefined()
    expect(caught?.message).not.toContain("\u001b")
    expect(caught?.message.length).toBeLessThan(500)
  })

  test("explains unsupported binary formats", async () => {
    await expect(extract("image.png", "image/png", strToU8("x"))).rejects.toThrow(/unsupported attachment format/)
  })
})
