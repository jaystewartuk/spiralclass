import { describe, expect, it } from "vitest";
import { csvResponse, toCsv } from "@/lib/csv";

// Tiny CSV serializer for admin finance exports. Excel-friendly: CRLF rows,
// quote only cells that need it, double-up embedded quotes, Dates as ISO.

describe("toCsv", () => {
  it("joins header + rows with CRLF", () => {
    const out = toCsv(
      ["a", "b"],
      [
        ["1", "2"],
        ["3", "4"],
      ],
    );
    expect(out).toBe("a,b\r\n1,2\r\n3,4");
  });

  it("quotes cells containing commas, quotes, or newlines", () => {
    const out = toCsv(["x"], [["a,b"], ['he said "hi"'], ["line\nbreak"]]);
    expect(out).toBe('x\r\n"a,b"\r\n"he said ""hi"""\r\n"line\nbreak"');
  });

  it("renders Dates as ISO strings and nullish as empty", () => {
    const out = toCsv(
      ["when", "who"],
      [
        [new Date("2026-06-01T00:00:00Z"), null],
        [undefined, "mira"],
      ],
    );
    expect(out).toBe("when,who\r\n2026-06-01T00:00:00.000Z,\r\n,mira");
  });

  it("returns just the header line for no rows", () => {
    expect(toCsv(["only"], [])).toBe("only");
  });

  // Regression: user-controlled names/emails must not be interpreted as
  // spreadsheet formulas when the export is opened. Cells starting with a
  // formula trigger are prefixed with a single quote (then quoted because the
  // apostrophe... no — because the payload contains commas/quotes/CR as usual).
  it("neutralizes formula-triggering cells (CSV injection)", () => {
    // `=` / `+` / `-` / `@` leaders are prefixed with a single quote.
    expect(toCsv(["x"], [["=1+2"]])).toBe("x\r\n'=1+2");
    expect(toCsv(["x"], [["+44 55"]])).toBe("x\r\n'+44 55");
    expect(toCsv(["x"], [["@handle"]])).toBe("x\r\n'@handle");
    // A classic exfiltration payload: neutralized AND quoted (contains commas).
    expect(toCsv(["name"], [['=HYPERLINK("http://evil","x"),1']])).toBe(
      'name\r\n"\'=HYPERLINK(""http://evil"",""x""),1"',
    );
    // A leading tab also triggers formula parsing in some apps; prefixed but
    // not quoted (a tab isn't a CSV delimiter).
    expect(toCsv(["x"], [["\t=1"]])).toBe("x\r\n'\t=1");
  });

  it("leaves an ordinary name untouched", () => {
    expect(toCsv(["name"], [["Alicia Moreno"]])).toBe("name\r\nAlicia Moreno");
    // A hyphen inside the value (not leading) is fine.
    expect(toCsv(["name"], [["Jean-Paul"]])).toBe("name\r\nJean-Paul");
  });
});

describe("csvResponse", () => {
  it("sets a CSV content-type and a timestamped attachment filename", async () => {
    const res = csvResponse("payments", "a,b\r\n1,2");
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toMatch(
      /^attachment; filename="payments-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.csv"$/,
    );
    expect(await res.text()).toBe("a,b\r\n1,2");
  });
});
