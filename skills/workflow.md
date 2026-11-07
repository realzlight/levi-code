# Levi Development Workflow
> Standards and practices for developing, testing, and debugging Levi features.

## Architecture Guidelines
- Modular agents: Keep tools, memory, retrieval, and prompt generation decoupled.
- Minimal overhead: Always favor fast paths and lazy loading for prompt context.
- Verification: Run syntax checks across all modules after edits to maintain code integrity.
