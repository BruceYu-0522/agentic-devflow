"""Git integration: auto branch creation, commit, and diff summary.

All operations are scoped to the workspace directory (devflow-runs/<id>/target-app/).
Failures return None silently — git is a convenience, not a hard requirement.
"""

import subprocess
from pathlib import Path


def _run_git(workspace: Path, *args: str) -> tuple[int, str, str]:
    """Run a git command. Returns (exit_code, stdout, stderr)."""
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=str(workspace),
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        return result.returncode, (result.stdout or "").strip(), (result.stderr or "").strip()
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return -1, "", "git command failed"


def is_git_available() -> bool:
    """Check if git is installed and accessible."""
    code, _, _ = _run_git(Path.cwd(), "--version")
    return code == 0


def ensure_git_repo(workspace: Path) -> bool:
    """Initialize a git repo in workspace if one doesn't exist."""
    if not workspace.exists():
        return False
    git_dir = workspace / ".git"
    if git_dir.exists():
        return True
    code, _, _ = _run_git(workspace, "init")
    return code == 0


def get_current_branch(workspace: Path) -> str | None:
    """Return the current branch name, or None."""
    code, stdout, _ = _run_git(workspace, "rev-parse", "--abbrev-ref", "HEAD")
    if code == 0 and stdout:
        return stdout
    return None


def create_devflow_branch(workspace: Path, branch_name: str) -> bool:
    """Create and switch to a new branch. Returns True on success."""
    code, _, _ = _run_git(workspace, "checkout", "-b", branch_name)
    # If branch already exists, just switch to it
    if code != 0:
        code, _, _ = _run_git(workspace, "checkout", branch_name)
    return code == 0


def commit_changes(workspace: Path, message: str) -> dict | None:
    """Stage all changes and commit. Returns commit info dict, or None when
    there is nothing to commit.

    Raises RuntimeError on a real git failure (status/add/commit error) so
    callers can fail the stage instead of silently pretending git worked.
    "No changes" is not a failure and still returns None.
    """
    # Check if there are changes to commit
    code, stdout, stderr = _run_git(workspace, "status", "--porcelain")
    if code != 0:
        raise RuntimeError(f"git status 失败：{stderr or '未知错误'}")
    if not stdout.strip():
        return None  # No changes to commit

    # Stage all changes
    code, _, stderr = _run_git(workspace, "add", "-A")
    if code != 0:
        raise RuntimeError(f"git add 失败：{stderr or '未知错误'}")

    # Ensure git user is configured for commit (otherwise commit fails)
    code, name, _ = _run_git(workspace, "config", "user.name")
    if code != 0 or not name:
        _run_git(workspace, "config", "user.name", "DevFlow Engine")
    code, email, _ = _run_git(workspace, "config", "user.email")
    if code != 0 or not email:
        _run_git(workspace, "config", "user.email", "devflow@local")

    # Commit
    code, stdout, stderr = _run_git(workspace, "commit", "-m", message)
    if code != 0:
        raise RuntimeError(f"git commit 失败：{stderr or stdout or '未知错误'}")

    # Get commit hash
    code, commit_hash, _ = _run_git(workspace, "rev-parse", "--short", "HEAD")
    if code != 0:
        commit_hash = "unknown"

    # Get changed files (use --root to handle the initial/root commit)
    code, diff_files, _ = _run_git(
        workspace, "diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "HEAD"
    )
    files = [f for f in (diff_files.split("\n") if diff_files else []) if f]

    return {"hash": commit_hash, "message": message, "files": files}


def get_diff_summary(workspace: Path, base_branch: str = "main") -> str:
    """Return a summary of changes: diff stat + recent commit log."""
    parts = []

    # Try to get diff stat against base branch
    code, stat, _ = _run_git(workspace, "diff", "--stat", base_branch, "HEAD")
    if code != 0:
        # Fall back to diff against initial commit
        code, stat, _ = _run_git(workspace, "diff", "--stat", "HEAD~1", "HEAD")
    if code == 0 and stat:
        parts.append(f"变更统计：\n{stat}")

    # Commit log
    code, log, _ = _run_git(workspace, "log", "--oneline", "-5")
    if code == 0 and log:
        parts.append(f"\n最近提交：\n{log}")

    # Changed files
    code, files, _ = _run_git(
        workspace, "diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "HEAD"
    )
    if code == 0 and files:
        parts.append(f"\n变更文件：\n{files}")

    return "\n".join(parts) if parts else "暂无 Git 变更信息"


def get_branch_name(pipeline_id: str) -> str:
    return f"devflow/{pipeline_id}"


def reset_to_commit(workspace: Path, message_prefix: str) -> bool:
    """Reset the repo (working tree included) to the newest commit whose
    message starts with ``message_prefix``. Returns True on success."""
    code, log, _ = _run_git(workspace, "log", "--format=%H %s")
    if code != 0 or not log.strip():
        return False
    for line in log.splitlines():
        parts = line.split(" ", 1)
        if len(parts) != 2:
            continue
        commit_hash, subject = parts
        if subject.startswith(message_prefix):
            code, _, _ = _run_git(workspace, "reset", "--hard", commit_hash)
            return code == 0
    return False


def rollback_before_commit(workspace: Path, message_prefix: str) -> bool:
    """Reset the repo to the parent of the newest commit whose message starts
    with ``message_prefix`` (e.g. "feat: " for the code stage, "test: " for
    the test stage), restoring the working tree to the state before that
    commit. Returns True on success, False when there is no such commit,
    it is the root commit (no parent to reset to), or git fails.

    Callers treat False as "rollback not possible" and fall back to marking
    the rejected artifacts instead of deleting them.
    """
    code, log, _ = _run_git(workspace, "log", "--format=%H %s")
    if code != 0 or not log.strip():
        return False
    lines = [line for line in log.splitlines() if line.strip()]
    for idx, line in enumerate(lines):
        parts = line.split(" ", 1)
        if len(parts) != 2:
            continue
        commit_hash, subject = parts
        if not subject.startswith(message_prefix):
            continue
        # Parent is the next (older) commit in newest-first log order.
        if idx + 1 >= len(lines):
            return False
        parent_hash = lines[idx + 1].split(" ", 1)[0]
        code, _, _ = _run_git(workspace, "reset", "--hard", parent_hash)
        return code == 0
    return False


def get_git_status_for_display(workspace: Path) -> dict | None:
    """Return a dict with branch, last commit, and changed files for frontend display."""
    branch = get_current_branch(workspace)
    if not branch:
        return None

    code, commit_hash, _ = _run_git(workspace, "rev-parse", "--short", "HEAD")
    code2, log, _ = _run_git(workspace, "log", "--oneline", "-3")

    return {
        "branch": branch,
        "commit": commit_hash if code == 0 else "",
        "log": log if code2 == 0 else "",
    }
