// Where the designs live. The site reads this repo and writes it through the upload proxy
// (worker/), which holds the GitHub token and checks the team password.
export const REPO = { owner: "darhanan", name: "design_files", branch: "main" };
export const MANIFEST = "designs.json";
export const CATEGORIES = "categories.json";
export const DESIGNS_DIR = "designs";
export const UNSORTED = { id: "unsorted", name: "Без категории", topics: [], keywords: [] };
export const API = "https://design-files.REPLACE_ME.workers.dev";
