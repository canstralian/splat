```markdown
# splat Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches you the core development patterns and conventions used in the `splat` Python codebase. You'll learn how to structure files, write imports and exports, follow commit message practices, and understand the project's approach to testing. This guide is ideal for contributors aiming for consistency and maintainability in the `splat` repository.

## Coding Conventions

### File Naming
- Use **snake_case** for all Python files.
  - Example: `data_loader.py`, `utils_math.py`

### Import Style
- Use **relative imports** within the package.
  - Example:
    ```python
    from .utils import calculate_area
    from .models import SplatModel
    ```

### Export Style
- Use **named exports** by explicitly listing symbols in `__all__` or via direct imports in `__init__.py`.
  - Example:
    ```python
    __all__ = ['SplatModel', 'calculate_area']
    ```

### Commit Messages
- Freeform style, no strict prefixes.
- Average commit message length: ~36 characters.
  - Example:  
    ```
    Fix bug in area calculation for edge cases
    ```

## Workflows

### Adding a New Module
**Trigger:** When you want to add new functionality as a module  
**Command:** `/add-module`

1. Create a new Python file using snake_case (e.g., `new_feature.py`).
2. Use relative imports for any internal dependencies.
3. Define your functions/classes and add them to `__all__` if needed.
4. Update the main package `__init__.py` to expose your module if applicable.
5. Write tests in a corresponding `*.test.*` file.

### Running Tests
**Trigger:** When you want to verify code correctness  
**Command:** `/run-tests`

1. Locate test files matching the pattern `*.test.*`.
2. Use the project's preferred test runner (framework is unknown; check project docs or use `pytest` as a default).
   - Example:
     ```bash
     pytest
     ```
3. Review test output and address any failures.

### Making a Commit
**Trigger:** When you are ready to save changes to version control  
**Command:** `/commit-changes`

1. Stage your changes:
   ```bash
   git add .
   ```
2. Write a concise, descriptive commit message (freeform, ~36 chars).
   ```bash
   git commit -m "Describe your change here"
   ```
3. Push your changes:
   ```bash
   git push
   ```

## Testing Patterns

- Test files follow the pattern `*.test.*` (e.g., `math_utils.test.py`).
- The testing framework is not explicitly specified; default to `pytest` or check for project-specific instructions.
- Place tests alongside the modules they test or in a dedicated tests directory.

  Example test file:
  ```python
  # math_utils.test.py
  from .math_utils import add

  def test_add():
      assert add(2, 3) == 5
  ```

## Commands
| Command         | Purpose                                   |
|-----------------|-------------------------------------------|
| /add-module     | Scaffold and add a new module             |
| /run-tests      | Run all test files in the repository      |
| /commit-changes | Commit your staged changes to git         |
```
