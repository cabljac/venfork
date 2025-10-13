---
"venfork": minor
---

Performance improvements and bug fixes:

- **Faster setup**: Changed from full repository mirror to cloning only the default branch, dramatically reducing setup time for large repositories
- **Fixed argument parsing**: Now supports both `--org value` and `--org=value` formats for the organization flag
