import type { GuestSessionWorktree } from '@openchamber/sdk';
import { mountBanner, mountButton, mountList, mountSelect, mountTextField, type SelectOption } from '@openchamber/sdk/ui';
import { DESCRIPTION_MAX, STATUSES, STATUS_LABELS, TITLE_MAX, type Task, type TaskPatch } from '../domain/task.ts';
import { describeHostError } from '../host/workspace.ts';
import {
  branchNameConflictsWithBase,
  buildSessionWorktree,
  DEFAULT_BASE_BRANCH_OPTION,
  DESTINATION_NEW,
  DESTINATION_ROOT,
  resolveBaseBranch,
} from '../domain/worktree.ts';
import { el } from './dom.ts';

export type SessionOption = { id: string; title: string; activity: string };
export type WorktreeOption = { id: string; label: string; hint?: string; disabled?: boolean };
export type WorktreeInfo = { destinations: WorktreeOption[]; baseBranches: SelectOption[]; hasKnownBranches: boolean };

export type TaskDetailProps = {
  task: Task;
  projects: Array<{ id: string; name: string }>;
  onSave: (patch: TaskPatch) => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
  onOpenChat: (sessionId: string) => Promise<void>;
  onLinkSession: (sessionId: string, projectId: string | null) => Promise<void>;
  onUnlinkSession: () => Promise<void>;
  onStartAgent: (input: { projectId: string; worktree: GuestSessionWorktree; title: string; description: string }) => Promise<void>;
  loadSessionsForProject: (projectId: string) => Promise<SessionOption[]>;
  loadWorktreeInfo: (projectId: string) => Promise<WorktreeInfo>;
};

const statusOptions: SelectOption[] = STATUSES.map((id) => ({ id, label: STATUS_LABELS[id] }));
const defaultBaseBranchOptions: SelectOption[] = [{ id: DEFAULT_BASE_BRANCH_OPTION, label: 'Use project default' }];

export const mountTaskDetail = (root: Element, props: TaskDetailProps) => {
  const overlay = el('div', 'kb-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const dialog = el('div', 'kb-dialog');
  overlay.append(dialog);
  root.append(overlay);

  const onKeydown = (event: KeyboardEvent) => { if (event.key === 'Escape') props.onClose(); };
  overlay.addEventListener('click', (event) => { if (event.target === overlay) props.onClose(); });
  document.addEventListener('keydown', onKeydown);

  let title = props.task.title;
  let description = props.task.description;
  let status = props.task.status;
  let projectId = props.task.projectId ?? '';
  let dirty = false;
  let busy = false;
  const hasSession = Boolean(props.task.sessionId);
  /** Reassigned once the Start Agent button exists; a no-op once a session is linked. */
  let updateStartAgentAvailability = () => {};

  dialog.append(el('h2', '', `Task · ${props.task.id}`));
  // Shown at both the top and the bottom of this (often tall, scrollable) dialog.
  // One error from one action taken anywhere in it — Save, Start Agent, link
  // session — so whichever end you're scrolled to, you still see it, without
  // relying on an auto-scroll that might not behave the same in every host.
  const errorSlotTop = el('div');
  dialog.append(errorSlotTop);
  const bannerTop = mountBanner(errorSlotTop, { tone: 'error', title: '' });
  errorSlotTop.hidden = true;
  const errorSlotBottom = el('div');
  errorSlotBottom.hidden = true;
  const bannerBottom = mountBanner(errorSlotBottom, { tone: 'error', title: '' });
  // The title names what actually failed — a failed session-list load used to
  // announce itself as "Could not save", which sent users hunting for a save
  // bug that never existed.
  const showError = (error: unknown, title = 'Could not save') => {
    const body = describeHostError(error);
    errorSlotTop.hidden = false; bannerTop.update({ tone: 'error', title, body });
    errorSlotBottom.hidden = false; bannerBottom.update({ tone: 'error', title, body });
  };
  const clearError = () => { errorSlotTop.hidden = true; errorSlotBottom.hidden = true; };

  /** Every field's onChange routes through here so the Save button always reflects there's something unsaved. */
  const markDirty = () => { dirty = true; clearError(); save.update({ disabled: false }); };

  const grid = el('div', 'kb-dialog-grid');
  dialog.append(grid);
  const titleWrap = el('div', 'kb-span2'); grid.append(titleWrap);
  const titleField = mountTextField(titleWrap, {
    label: 'Title', value: title,
    onChange: (value) => { title = value; markDirty(); titleField.update({ value }); updateStartAgentAvailability(); },
  });
  const descWrap = el('div', 'kb-span2'); grid.append(descWrap);
  const descField = mountTextField(descWrap, {
    label: 'Description / agent prompt', value: description, multiline: true, rows: 6,
    helper: 'This is what the agent sees as its first message when you start a session.',
    onChange: (value) => { description = value; markDirty(); descField.update({ value }); updateStartAgentAvailability(); },
  });
  const statusWrap = el('div'); grid.append(statusWrap);
  const statusField = mountSelect(statusWrap, {
    label: 'Status', value: status, options: statusOptions,
    onChange: (value) => { status = value as Task['status']; markDirty(); statusField.update({ value }); renderQuickMoveButtons(); },
  });
  const projectWrap = el('div'); grid.append(projectWrap);
  const projectField = mountSelect(projectWrap, {
    label: 'Project', value: projectId || null, placeholder: 'No project',
    options: [{ id: '', label: 'No project' }, ...props.projects.map((p) => ({ id: p.id, label: p.name }))],
    searchable: props.projects.length > 6,
    onChange: (value) => {
      projectId = value; markDirty(); projectField.update({ value });
      refreshSessionPicker();
      refreshWorktreeOptions();
      updateStartAgentAvailability();
    },
  });
  const saveRow = el('div', 'kb-row'); dialog.append(saveRow);
  const save = mountButton(saveRow, {
    label: 'Save changes', disabled: !dirty,
    onClick: () => {
      void (async () => {
        busy = true; save.update({ loading: true });
        try {
          await props.onSave({ title, description, status, projectId: projectId || null });
          dirty = false; save.update({ disabled: true });
        } catch (error) { showError(error); }
        finally { busy = false; save.update({ loading: false }); }
      })();
    },
  });
  // One quick-move button per column except the one the task is already in,
  // so moving to any status is always a single click, not just Review/Done.
  const quickMoveRow = el('div', 'kb-row'); dialog.append(quickMoveRow);
  quickMoveRow.append(el('span', 'kb-muted', 'Move to:'));
  let quickMoveButtons: Array<{ dispose: () => void }> = [];
  const renderQuickMoveButtons = () => {
    for (const button of quickMoveButtons) button.dispose();
    quickMoveButtons = STATUSES.filter((target) => target !== status).map((target) => mountButton(quickMoveRow, {
      label: target === 'done' ? 'Mark Done' : `Move to ${STATUS_LABELS[target]}`,
      variant: 'secondary', size: 'sm',
      onClick: () => void quickStatus(target),
    }));
  };

  const quickStatus = async (next: Task['status']) => {
    if (busy) return;
    busy = true;
    try {
      await props.onSave({ status: next });
      status = next; statusField.update({ value: status }); renderQuickMoveButtons();
      dirty = title !== props.task.title || description !== props.task.description || projectId !== (props.task.projectId ?? '');
      save.update({ disabled: !dirty });
    } catch (error) { showError(error); }
    finally { busy = false; }
  };
  renderQuickMoveButtons();

  const sessionSection = el('div', 'kb-section'); dialog.append(sessionSection);
  sessionSection.append(el('div', 'kb-section-title', 'OpenCode session'));
  const sessionBody = el('div', 'kb-row'); sessionSection.append(sessionBody);

  // Shown only once a session is linked.
  const renderSessionBody = () => {
    sessionBody.replaceChildren();
    if (!props.task.sessionId) return;
    sessionBody.append(el('span', 'kb-mono', props.task.sessionId));
    mountButton(sessionBody, {
      label: 'Open Chat',
      onClick: () => { void props.onOpenChat(props.task.sessionId!).catch((error) => showError(error, 'Could not open the chat')); },
    });
    mountButton(sessionBody, {
      label: 'Unlink', variant: 'ghost',
      onClick: () => { void props.onUnlinkSession().catch((error) => showError(error, 'Could not unlink the session')); },
    });
  };
  renderSessionBody();

  // --- Start Agent: shown only before a session is linked ---
  const startRoot = el('div');
  const pickerRoot = el('div');
  sessionSection.append(startRoot, pickerRoot);
  startRoot.hidden = hasSession;
  pickerRoot.hidden = hasSession;

  type StartFromMode = typeof DESTINATION_ROOT | typeof DESTINATION_NEW | 'existing';
  let startFromMode: StartFromMode = DESTINATION_ROOT;
  let existingWorktreeId = '';
  let branchName = '';
  let baseBranchSelection = DEFAULT_BASE_BRANCH_OPTION;
  let startBusy = false;
  let worktreeGeneration = 0;
  let refreshWorktreeOptions = () => {};

  if (!hasSession) {
    startRoot.append(el('p', 'kb-muted', 'Starts a real OpenCode session with the description above as its first message, and links it to this task.'));
    const startGrid = el('div', 'kb-dialog-grid'); startRoot.append(startGrid);

    // "Start from" — a radio choice, not a dropdown, same layout as OpenChamber's
    // own New Worktree dialog. "MR or issue" from that dialog has no equivalent
    // here (needs a connected GitLab/Linear account, unrelated to this board).
    const startFromWrap = el('div'); startGrid.append(startFromWrap);
    startFromWrap.append(el('div', 'kb-section-title', 'Start from'));
    const radioGroup = el('div', 'kb-radio-group'); startFromWrap.append(radioGroup);
    const radioName = `kb-start-from-${props.task.id}`;
    const startFromOptions: Array<{ id: StartFromMode; title: string; desc: string }> = [
      { id: DESTINATION_ROOT, title: 'Project root', desc: 'Run directly in the main checkout, no worktree.' },
      { id: DESTINATION_NEW, title: 'New branch', desc: 'A fresh branch and worktree, based on the branch you pick.' },
      { id: 'existing', title: 'Existing worktree', desc: 'Reuse a worktree you already have checked out.' },
    ];
    for (const option of startFromOptions) {
      const optionLabel = el('label', 'kb-radio-option');
      const input = document.createElement('input');
      input.type = 'radio'; input.name = radioName; input.value = option.id; input.checked = option.id === startFromMode;
      const textWrap = el('div');
      textWrap.append(el('div', 'kb-radio-title', option.title), el('div', 'kb-radio-desc', option.desc));
      optionLabel.append(input, textWrap);
      radioGroup.append(optionLabel);
      input.addEventListener('change', () => {
        if (!input.checked) return;
        startFromMode = option.id;
        newBranchFields.hidden = startFromMode !== DESTINATION_NEW;
        existingWorktreeFields.hidden = startFromMode !== 'existing';
        updateStartAgentAvailability();
      });
    }

    const fieldsWrap = el('div'); startGrid.append(fieldsWrap);

    // New branch: name, base branch, and a read-only "Folder name" that always
    // mirrors it — the SDK's startSession has one `name` for both, with no way
    // to set a separate folder name independently (unlike OpenChamber's own
    // dialog, which has full, unsandboxed git access this extension doesn't).
    const newBranchFields = el('div', 'kb-dialog-grid'); fieldsWrap.append(newBranchFields);
    newBranchFields.hidden = true;
    const branchNameField = mountTextField(newBranchFields, {
      label: 'Branch name', value: '', placeholder: 'e.g. fix/login-redirect',
      onChange: (value) => {
        branchName = value; branchNameField.update({ value }); folderNameField.update({ value: branchName });
        updateStartAgentAvailability();
      },
    });
    const baseBranchSelect = mountSelect(newBranchFields, {
      label: 'Based on', value: baseBranchSelection, options: defaultBaseBranchOptions, searchable: true,
      searchPlaceholder: 'Search branches…',
      onChange: (value) => {
        baseBranchSelection = value; baseBranchSelect.update({ value });
        updateStartAgentAvailability();
      },
    });
    const baseBranchNote = el('p', 'kb-muted kb-span2');
    newBranchFields.append(baseBranchNote);
    const folderNameWrap = el('div', 'kb-span2'); newBranchFields.append(folderNameWrap);
    const folderNameField = mountTextField(folderNameWrap, {
      label: 'Folder name', value: '', disabled: true,
      helper: "Always the same as the branch name above — this SDK has no way to set a separate folder name.",
      onChange: () => {},
    });

    // Existing worktree: just pick one. No branch/base-branch fields — reusing an
    // existing worktree doesn't create anything new.
    const existingWorktreeFields = el('div'); fieldsWrap.append(existingWorktreeFields);
    existingWorktreeFields.hidden = true;
    const existingWorktreeSelect = mountSelect(existingWorktreeFields, {
      label: 'Worktree', value: null, placeholder: 'Choose a worktree…', options: [],
      onChange: (value) => { existingWorktreeId = value; existingWorktreeSelect.update({ value }); updateStartAgentAvailability(); },
    });
    const existingWorktreeNote = el('p', 'kb-muted', '');
    existingWorktreeFields.append(existingWorktreeNote);

    const needsBeforeStartNote = el('p', 'kb-muted', '');
    startRoot.append(needsBeforeStartNote);
    const startRow = el('div', 'kb-row'); startRoot.append(startRow);
    const canStartAgent = () => {
      if (!projectId || !title.trim() || !description.trim()) return false;
      if (startFromMode === DESTINATION_NEW) {
        if (!branchName.trim()) return false;
        if (branchNameConflictsWithBase(branchName, resolveBaseBranch(baseBranchSelection))) return false;
      }
      if (startFromMode === 'existing') return existingWorktreeId.length > 0;
      return true;
    };
    const startButton = mountButton(startRow, {
      label: 'Start Agent', disabled: !canStartAgent(),
      onClick: () => {
        void (async () => {
          if (startBusy || !canStartAgent()) return;
          startBusy = true; startButton.update({ loading: true });
          try {
            const destination = startFromMode === 'existing' ? existingWorktreeId : startFromMode;
            const worktree = buildSessionWorktree(destination, branchName, resolveBaseBranch(baseBranchSelection));
            // Whatever is currently typed, saved or not — Start Agent must not silently
            // fall back to the title/description this task had when the popup opened.
            await props.onStartAgent({ projectId, worktree, title, description });
          } catch (error) { showError(error, 'Could not start the agent'); }
          finally { startBusy = false; startButton.update({ loading: false }); }
        })();
      },
    });
    updateStartAgentAvailability = () => {
      const missing: string[] = [];
      if (!projectId) missing.push('choose a project');
      if (!title.trim()) missing.push('give it a title above');
      if (!description.trim()) missing.push('add a description above');
      if (startFromMode === DESTINATION_NEW) {
        if (!branchName.trim()) missing.push('name the new branch');
        else if (branchNameConflictsWithBase(branchName, resolveBaseBranch(baseBranchSelection))) {
          missing.push("pick a different base branch — it can't be the same as the new branch name");
        }
      }
      if (startFromMode === 'existing' && !existingWorktreeId) missing.push('choose a worktree');
      startButton.update({ disabled: missing.length > 0 });
      needsBeforeStartNote.hidden = missing.length === 0;
      if (missing.length > 0) needsBeforeStartNote.textContent = `Before you can start an agent: ${missing.join(', ')}.`;
    };
    updateStartAgentAvailability();

    const noKnownBranchesNote = 'The local branch-lookup service isn\'t approved or available, and this project has no existing worktree to list branches from either — only "Use project default" is available. Approve the service in Settings → Extensions for a searchable branch list.';
    baseBranchNote.textContent = '';
    refreshWorktreeOptions = () => {
      const generation = ++worktreeGeneration;
      baseBranchSelect.update({ value: baseBranchSelection, options: defaultBaseBranchOptions });
      existingWorktreeSelect.update({ value: existingWorktreeId || null, options: [] });
      existingWorktreeNote.textContent = '';
      if (!projectId) { baseBranchNote.textContent = ''; return; }
      void props.loadWorktreeInfo(projectId).then((info) => {
        if (generation !== worktreeGeneration) return;
        existingWorktreeSelect.update({ options: info.destinations.map((w) => ({ id: w.id, label: w.label, hint: w.hint, disabled: w.disabled })) });
        if (info.destinations.length === 0) existingWorktreeNote.textContent = 'No existing worktrees in this project yet.';
        baseBranchSelect.update({ options: info.baseBranches });
        baseBranchNote.textContent = info.hasKnownBranches ? '' : noKnownBranchesNote;
      }, (error) => { if (generation === worktreeGeneration) showError(error, 'Could not load worktrees'); });
    };
    refreshWorktreeOptions();
  }

  let picker: { dispose: () => void } | null = null;
  let pickerGeneration = 0;

  const renderPicker = () => {
    picker?.dispose(); picker = null;
    pickerRoot.replaceChildren();
    if (hasSession) return;
    if (!projectId) { pickerRoot.append(el('p', 'kb-muted', 'Or choose a project above to link an existing session instead.')); return; }
    pickerRoot.append(el('div', 'kb-section-title', 'Or link an existing session'));
    const generation = ++pickerGeneration;
    const list = mountList(pickerRoot, {
      ariaLabel: 'Sessions available to link',
      items: [], emptyText: 'Loading sessions…',
      onSelect: (id) => { void props.onLinkSession(id, projectId || null).catch((error) => showError(error, 'Could not link the session')); },
    });
    picker = list;
    void props.loadSessionsForProject(projectId).then((sessions) => {
      if (generation !== pickerGeneration) return;
      list.update({
        items: sessions.map((s) => ({ id: s.id, title: s.title, subtitle: s.id, badge: { label: s.activity, tone: s.activity === 'running' ? 'info' : 'neutral' } })),
        emptyText: 'No sessions in this project yet.',
      });
    }, (error) => { if (generation === pickerGeneration) showError(error, 'Could not load sessions'); });

  };
  const refreshSessionPicker = () => { renderPicker(); };
  renderPicker();

  dialog.append(errorSlotBottom);
  const footer = el('div', 'kb-row between'); dialog.append(footer);
  const dangerRow = el('div', 'kb-row'); footer.append(dangerRow);
  let confirmingDelete = false;
  const deleteBtn = mountButton(dangerRow, {
    label: 'Delete task', variant: 'ghost',
    onClick: () => {
      if (!confirmingDelete) { confirmingDelete = true; deleteBtn.update({ label: 'Click again to delete', variant: 'destructive' }); return; }
      void props.onDelete().catch((error) => showError(error, 'Could not delete the task'));
    },
  });
  mountButton(footer, { label: 'Close', variant: 'outline', onClick: () => props.onClose() });

  const dispose = () => { document.removeEventListener('keydown', onKeydown); overlay.remove(); };
  return { dispose };
};
