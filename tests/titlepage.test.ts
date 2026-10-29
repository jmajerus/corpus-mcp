import { describe, expect, it } from "vitest";
import { mangledTitle, personName, scanTitlePage } from "../src/titlepage.js";

const page = (page_index: number, text: string, section_path: string | null = null) => ({ page_index, section_path, text });
const names = (r: ReturnType<typeof scanTitlePage>) => r.authors.map((a) => a.name);

describe("title-page scan", () => {
  it("reads a Packt book: the title page, its copyright page, and About the authors", () => {
    const r = scanTitlePage([
      page(0, "", "Cover"),
      page(1, "AWS Cloud Projects\n\nStrengthen your AWS skills through practical projects, from websites to advanced AI applications\n\nIvo Pinto\n\nPedro Santos", "Copyright and Credits"),
      page(2, "AWS Cloud Projects\n\nCopyright © 2024 Packt Publishing\n\nAll rights reserved.\n\nGroup Product Manager: Preet Ahuja\n\nTechnical Editor: Rajat Sharma\n\nFirst published: October 2024", "Copyright and Credits"),
      page(4, "Contributors\n\nAbout the authors\n\nIvo Pinto, CCIE No. 57162 (R&S, Security, and Data Center), CISSP, is a principal solutions architect.\n\nPedro Santos is a senior solutions architect.\n\nAbout the reviewers\n\nJane Reviewer is a cloud engineer.", "Contributors"),
    ], "awscloudprojects");
    expect(names(r)).toEqual(["Ivo Pinto", "Pedro Santos"]);
    expect(r.authors[0].sources).toEqual(["about", "title_page"]);
    expect(r.title).toEqual({ title: "AWS Cloud Projects", page: 2 });
  });

  it("splits names run together on the title page by what About the author says", () => {
    const r = scanTitlePage([
      page(1, "Mastering Rust Second Edition\n\nLearn about memory safety, type system, concurrency, and the new features of Rust 2018 edition\n\nRahul Sharma Vesa Kaihlavirta\n\nBIRMINGHAM - MUMBAI", "Title Page"),
      page(4, "Contributors\n\nAbout the author\n\nRahul Sharma is passionately curious about teaching programming.\n\nVesa Kaihlavirta has been programming since he was five.", "Contributors"),
    ], "MASTERING RUST SE");
    expect(names(r)).toEqual(["Rahul Sharma", "Vesa Kaihlavirta"]);
  });

  it("never takes a run-together line as one person", () => {
    const r = scanTitlePage([page(1, "Mastering Rust\n\nRahul Sharma Vesa Kaihlavirta", "Title Page")], "Mastering Rust");
    expect(names(r)).toEqual([]);
  });

  it("reads by-lines and copyright holders, never publishers or a part's holder", () => {
    expect(names(scanTitlePage([page(1, "THE ELEMENTS OF STYLE\n\nBY WILLIAM STRUNK, Jr.\n\nCOPYRIGHT, 1918, 1919, BY\n\nWILLIAM STRUNK, JR.\n\nCOPYRIGHT, 1920, BY HARCOURT, BRACE AND HOWE, INC.")], "The Elements of Style")))
      .toEqual(["William Strunk, Jr."]);
    expect(names(scanTitlePage([page(5, "Copyright 2016 by Kelly Oliver\n\nAll rights reserved.")], "Carceral Humanitarianism"))).toEqual(["Kelly Oliver"]);
    expect(names(scanTitlePage([page(1, "ISBN 978-1-4842-7204-6\n\n© Kit Eason 2022\n\nThis work is subject to copyright. All rights are reserved by the Publisher.")], "Stylish F# 6"))).toEqual(["Kit Eason"]);
    expect(names(scanTitlePage([page(1, "© Shashank Mohan Jain 2020, 2023")], "Linux Containers"))).toEqual(["Shashank Mohan Jain"]);
    expect(names(scanTitlePage([page(1, "Copyright © 2021 The Pragmatic Programmers, LLC.\n\nCopyright © 2024 Packt Publishing")], "Intuitive Python"))).toEqual([]);
    expect(names(scanTitlePage([page(1, "Translation, preface, and notes copyright © 1998 by Martin Chalmers")], "I Will Bear Witness"))).toEqual([]);
  });

  it("finds no person in an organisation's report", () => {
    expect(names(scanTitlePage([page(3, "DIAGNOSTIC AND STATISTICAL\n\nMANUAL OF MENTAL DISORDERS\n\nFIFTH EDITION TEXT REVISION\n\nDSM-5-TR™", "Cover Page"),
      page(4, "American Psychiatric Association\n\nDSM-5-TR\n\nOfficers 2021–2022\n\nPRESIDENT VIVIAN B. PENDER, M.D.", "Cover Page")], "Diagnostic and Statistical Manual"))).toEqual([]);
  });

  it("tells a file name from a title", () => {
    for (const t of ["awscloudprojects", "masteringgo fourthedition", "Book-layout1.indd", "Microsoft Word - LesterBook.doc", "B40332_Building Claude Skills", "c13andnet9 moderncross-platformdevelopment"]) expect(mangledTitle(t), t).toBe(true);
    for (const t of ["The Elements of Style", "MASTERING RUST SE", "Scala: Guide for Data Science Professionals", "Data Fluency"]) expect(mangledTitle(t), t).toBe(false);
  });

  it("matches a squashed title, edition and all", () => {
    expect(scanTitlePage([page(1, "Microsoft Power BI Cookbook Third Edition\n\nConvert raw data\n\nGreg Deckler\n\nBrett Powell", "Cover")], "microsoftpowerbicookbook 3rd edition").title?.title)
      .toBe("Microsoft Power BI Cookbook Third Edition");
    expect(scanTitlePage([page(1, "Mastering Go\n\nFourth Edition")], "masteringgo fourthedition").title?.title).toBe("Mastering Go");
  });

  it("tidies names", () => {
    expect(personName("Dr. Jane Q. Public")).toBe("Jane Q. Public");
    expect(personName("Ludwig van Beethoven")).toBe("Ludwig van Beethoven");
    expect(personName("Greg")).toBeNull();
    expect(personName("Packt Publishing")).toBeNull();
  });
});
