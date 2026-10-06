import { describe, it, expect } from "vitest";
import {
  isOwnCompany,
  ownCompanyOf,
  registrableDomain,
} from "../../src/services/own-company.js";

describe("own company", () => {
  const cern = ownCompanyOf({ domain: "home.cern", url: "https://home.cern", name: "CERN", salesRepEmail: "rep@cern.ch" });

  it("matches the brand's domain, its subdomains, its rep's work domain, and its exact name", () => {
    expect(isOwnCompany(cern, { domain: "home.cern" })).toBe(true);
    expect(isOwnCompany(cern, { website: "https://it.home.cern/x" })).toBe(true);
    expect(isOwnCompany(cern, { email: "s@cern.ch" })).toBe(true);
    expect(isOwnCompany(cern, { name: "C.E.R.N." })).toBe(true);
  });

  it("does not match other companies", () => {
    expect(isOwnCompany(cern, { domain: "infn.it", name: "INFN" })).toBe(false);
    expect(isOwnCompany(cern, { name: "CERN Courier Ltd" })).toBe(false);
  });

  it("a subdomain brand excludes its whole registrable domain", () => {
    const sub = ownCompanyOf({ domain: "home.web.cern.ch", url: null, name: "Home", salesRepEmail: null });
    expect(isOwnCompany(sub, { email: "x@cern.ch" })).toBe(true);
  });

  it("never uses a free-mail rep domain, a hosting platform, or a URL-as-name", () => {
    const o = ownCompanyOf({ domain: "facebook.com", url: null, name: "http://info.cern.ch", salesRepEmail: "me@gmail.com" });
    expect(o.domains.size).toBe(0);
    expect(o.names.size).toBe(0);
  });

  it("respects multi-part public suffixes", () => {
    expect(registrableDomain("shop.acme.co.uk")).toBe("acme.co.uk");
    const uk = ownCompanyOf({ domain: "acme.co.uk", url: null, name: "Acme", salesRepEmail: null });
    expect(isOwnCompany(uk, { domain: "other.co.uk" })).toBe(false);
  });
});
