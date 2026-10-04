import { expect, test } from "bun:test";

import { resolveSearchRequest } from "../../../src/core/search/pipeline/request.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";

const config = makeConfig({ vault: "vault", dbPath: "vault/.open-second-brain/brain.sqlite" });

test.each(["../up", "/etc", "C:/Users", "c:\\Users", "D:notes"])(
  "a path_prefix outside the vault is refused at query time (%p)",
  (pathPrefix) => {
    expect(() => resolveSearchRequest(config, { query: "fox", pathPrefix })).toThrow(
      "path_prefix escapes vault",
    );
  },
);

test.each(["Notes/", "Projects/C:x", "c-notes/"])(
  "a vault-relative path_prefix is kept (%p)",
  (pathPrefix) => {
    expect(resolveSearchRequest(config, { query: "fox", pathPrefix }).pathPrefix).toBe(pathPrefix);
  },
);
