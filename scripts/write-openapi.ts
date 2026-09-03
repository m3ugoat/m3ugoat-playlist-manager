// Emits openapi.json from openapi.ts, for external tooling (Swagger UI,
// client generators, API consoles). openapi.ts remains the source of truth.
//
//   npm run openapi:write

import fs from "fs";
import path from "path";

const { openapi } = await import("../openapi.ts");
const out = path.join(process.cwd(), "openapi.json");
fs.writeFileSync(out, JSON.stringify(openapi, null, 2) + "\n");
console.log(`Wrote ${out} (${Object.keys((openapi as any).paths).length} paths)`);
