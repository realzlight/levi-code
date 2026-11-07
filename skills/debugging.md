# Levi Debugging & Diagnostics
> Recipes for diagnosing session state, retrieval index health, and UI forms.

## Diagnostic Steps
- Test syntax across all modules: `find src bin -name "*.js" -exec node --check {} +`
- Inspect plugins database: `cat ~/.levi/plugins.json`
- Verify retrieval sources: Run test retrieval query via scratch benchmark.
