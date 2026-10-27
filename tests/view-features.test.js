'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

// ------------------------------------------------------------------ assistant context rail

test('assistant lives beside task details instead of blocking the calendar in a modal', () => {
  const panel = indexHtml.match(/<aside class="details-panel" id="contextPanel"[\s\S]*?<\/aside>/);
  assert.ok(panel, 'right context panel should exist');
  assert.match(panel[0], /id="detailsContextTab"/);
  assert.match(panel[0], /id="assistantContextTab"/);
  assert.match(panel[0], /id="assistantContext"/);
  assert.doesNotMatch(indexHtml, /id="assistantOverlay"/);
});

test('assistant entry points switch the right context rail and preserve a narrow-window drawer', () => {
  assert.match(rendererSource, /function setContextPanel\(name\)/);
  assert.match(rendererSource, /panel\.classList\.toggle\('assistant-open', assistantActive\)/);
  assert.match(rendererSource, /\$\('#assistantContext'\)\.hidden = !assistantActive/);
  assert.match(stylesSource, /\.details-panel\.assistant-open\s*\{[\s\S]*?position:\s*fixed;/);
  assert.match(stylesSource, /@media \(max-width: 720px\)[\s\S]*?\.details-panel\.assistant-open\s*\{[\s\S]*?width:\s*100%;/);
});

test('Font Awesome remains the primary icon source while assistant branding matches the main worktree', () => {
  assert.match(indexHtml, /@fortawesome\/fontawesome-free\/css\/all\.min\.css/);
  assert.match(indexHtml, /node_modules\/lucide\/dist\/umd\/lucide\.js/);
  assert.match(indexHtml, /class="assistant-logo" data-lucide="sparkles"/);
  assert.match(rendererSource, /FONT_AWESOME_ICONS/);
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(packageJson.dependencies['@fortawesome/fontawesome-free']);
  assert.ok(packageJson.dependencies.lucide);
  assert.equal(packageJson.build.win.icon, 'assets/app-icon.ico');
  assert.ok(fs.existsSync(path.join(root, 'assets', 'app-icon.png')));
  assert.ok(fs.existsSync(path.join(root, 'assets', 'app-icon.ico')));
});

test('clickable icons use consistent hitboxes without letting glyphs intercept clicks', () => {
  assert.match(stylesSource, /--icon-hitbox:\s*34px;/);
  assert.match(stylesSource, /--icon-hitbox-compact:\s*32px;/);
  assert.match(stylesSource, /\.app-icon\s*\{[\s\S]*?pointer-events:\s*none;/);
  assert.match(stylesSource, /\.icon-btn\s*\{[\s\S]*?width:\s*var\(--icon-hitbox\);[\s\S]*?height:\s*var\(--icon-hitbox\);/);
  assert.match(stylesSource, /\.icon-btn\.small\s*\{[\s\S]*?width:\s*var\(--icon-hitbox-compact\);[\s\S]*?height:\s*var\(--icon-hitbox-compact\);/);
  assert.match(stylesSource, /\.task-check\s*\{[\s\S]*?width:\s*var\(--icon-hitbox\);[\s\S]*?height:\s*var\(--icon-hitbox\);/);
  assert.match(stylesSource, /\.task-check::before\s*\{[\s\S]*?width:\s*22px;[\s\S]*?height:\s*22px;/);
  assert.match(stylesSource, /@media \(max-width: 720px\)[\s\S]*?\.topbar-right \.sync-status-pill\s*\{\s*display:\s*none;/);
});

test('settings no longer expose obsolete client-side AI provider configuration', () => {
  assert.doesNotMatch(indexHtml, /<h2>AI 服务<\/h2>/);
  assert.doesNotMatch(indexHtml, /id="aiProvider"|id="providerFields"/);
  assert.doesNotMatch(rendererSource, /providerDefaults|captureProviderFields|renderProviderFields/);
});

test('composer AI mode bypasses local command parsing and submits directly to the agent', () => {
  assert.match(indexHtml, /id="composerAssistant"[\s\S]*?aria-pressed="false"/);
  assert.match(rendererSource, /function setAssistantComposerMode\(enabled\)/);
  assert.match(rendererSource, /if \(state\.assistantComposerMode\) \{[\s\S]*?openAssistant\(\);[\s\S]*?await sendAssistantMessage\(text\);[\s\S]*?return;/);
  assert.match(rendererSource, /setAssistantComposerMode\(true\);[\s\S]*?if \(\$\('#quickInput'\)\.value\.trim\(\)\) await submitQuickCommand\(\);/);
  assert.match(rendererSource, /AI 助手模式，按 Enter 直接提交给模型/);
});

test('assistant uses the main worktree sparkles mark and a paper plane for submission', () => {
  assert.match(indexHtml, /id="composerAssistant"[\s\S]*?data-lucide="sparkles"/);
  assert.match(indexHtml, /id="quickSubmit"[\s\S]*?fa-paper-plane/);
  assert.doesNotMatch(indexHtml, /id="quickSubmit"[\s\S]{0,160}?fa-plus/);
  assert.match(rendererSource, /window\.lucide\?\.createIcons/);
});

test('assistant text attachments use a constrained local picker and existing model message channel', () => {
  assert.match(indexHtml, /id="quickAttachment"[\s\S]*?fa-paperclip/);
  assert.match(indexHtml, /id="assistantAttachment"[\s\S]*?fa-paperclip/);
  assert.match(mainSource, /ATTACHMENT_MAX_FILES = 5/);
  assert.match(mainSource, /ATTACHMENT_MAX_BYTES = 512 \* 1024/);
  assert.match(mainSource, /assistant-pick-attachments/);
  assert.match(preloadSource, /contextBridge\.exposeInMainWorld\('attachmentAPI'/);
  assert.match(rendererSource, /function messageWithAttachments\(message, attachments\)/);
  assert.match(rendererSource, /window\.aiAPI\?\.chat\(modelMessage\)/);
});

test('attachment remove control keeps a full compact icon hitbox', () => {
  assert.match(stylesSource, /\.attachment-remove\s*\{[\s\S]*?width:\s*32px;[\s\S]*?height:\s*32px;/);
});

// ------------------------------------------------------------------ return button

test('main header contains a return-today button with a mutable label', () => {
  assert.match(indexHtml, /id="returnTodayButton"/);
  assert.match(indexHtml, /id="returnTodayLabel"/);
  const block = indexHtml.match(/<button class="text-btn return-today-button" id="returnTodayButton"[\s\S]*?<\/button>/);
  assert.ok(block, 'return button markup should exist');
  assert.match(block[0], /fa-arrow-rotate-left/);
});

test('return button is hidden by default via visibility so layout does not jump', () => {
  assert.match(stylesSource, /\.return-today-button\s*\{\s*visibility:\s*hidden;/);
  assert.match(stylesSource, /\.return-today-button\.visible\s*\{\s*visibility:\s*visible;/);
});

test('renderer toggles the return button visible only when today is outside the view range', () => {
  assert.match(
    rendererSource,
    /button\.classList\.toggle\('visible', !inRange\)/,
  );
  assert.match(
    rendererSource,
    /const inRange = viewRangeIncludesDateFor\(state\.currentView, state\.selectedDate, realToday\)/,
  );
});

test('return button label follows the view mode: 今天 / 本周 / 本月', () => {
  assert.match(rendererSource, /const VIEW_RETURN_LABELS = \{ day: '今天', week: '本周', month: '本月' \};/);
  assert.match(rendererSource, /`返回\$\{VIEW_RETURN_LABELS\[state\.currentView\] \|\| '今天'\}`/);
});

test('return button click goes back to today without changing the view mode', () => {
  assert.match(
    rendererSource,
    /\$\('#returnTodayButton'\)\.addEventListener\('click', \(\) => selectDate\(realToday\)\);/,
  );
});

test('view range helpers are exposed to the renderer through a preload bridge', () => {
  assert.match(preloadSource, /const \{ viewRange, viewRangeIncludesDate, viewRangeTitle \} = require\('\.\/src\/core\/date-utils'\);/);
  assert.match(preloadSource, /contextBridge\.exposeInMainWorld\('viewUtils'/);
  assert.match(preloadSource, /viewRangeIncludesDate: \(view, value, target\) => viewRangeIncludesDate\(view, value, target\)/);
});

// ------------------------------------------------------------------ year in view titles

test('main view title always renders the year via viewRangeTitleFor', () => {
  assert.match(rendererSource, /\$\('#mainDateTitle'\)\.textContent = viewTitleText\(\);/);
  assert.match(rendererSource, /const base = viewRangeTitleFor\(state\.currentView, selected\);/);
  assert.match(rendererSource, /`\$\{start\.getFullYear\(\)\}年\$\{monthDay\(start\)\}`/);
});

test('cross-year week titles render both years in the renderer fallback', () => {
  assert.match(
    rendererSource,
    /if \(start\.getFullYear\(\) !== end\.getFullYear\(\)\) \{\s*return `\$\{start\.getFullYear\(\)\}年\$\{monthDay\(start\)\} – \$\{end\.getFullYear\(\)\}年\$\{monthDay\(end\)\}`;\s*\}/,
  );
});

test('day view title appends the weekday and a 今天 prefix on the current date', () => {
  assert.match(rendererSource, /const text = `\$\{base\} \$\{DAY_NAMES\[selected\.getDay\(\)\]\}`;/);
  assert.match(rendererSource, /sameDay\(selected, realToday\) \? `今天 · \$\{text\}` : text/);
});

// ------------------------------------------------------------------ task type in the detail dialog

test('detail dialog shows Deadline with explicit date and time', () => {
  assert.match(
    rendererSource,
    /`Deadline · 截止 \$\{dateText\}\$\{timeText\} · \$\{calendar\}`/,
  );
  assert.match(rendererSource, /const timeText = event\.time \? ` \$\{event\.time\}` : '';/);
  assert.match(rendererSource, /year: 'numeric', month: 'long', day: 'numeric'/);
});

test('detail dialog shows the recurrence rule and end date for recurring tasks', () => {
  assert.match(rendererSource, /`重复任务 · \$\{recurrenceLabel\(event\)\}\$\{until\} · \$\{calendar\}`/);
  assert.match(rendererSource, /const until = event\.endDate/);
});

test('normal tasks are labeled 普通任务 in the detail dialog', () => {
  assert.match(rendererSource, /return `普通任务 · \$\{calendar\}`;/);
});

test('recurrence label includes concrete weekly days', () => {
  assert.match(
    rendererSource,
    /const days = \(event\.recurringDays \|\| \[\]\)[\s\S]*?\.join\('、'\)/,
  );
  assert.match(rendererSource, /return days \? `每周\$\{days\}` : '每周';/);
});

// ------------------------------------------------------------------ recurring weekday editing

test('detail dialog renders a weekday picker with all seven days', () => {
  assert.match(rendererSource, /data-weekday-picker/);
  assert.match(rendererSource, /SHORT_DAY_NAMES\.map\(\(name, day\) =>/);
  assert.match(rendererSource, /data-weekday="\$\{day\}"/);
});

test('weekday picker prefills the selected days from the recurring rule', () => {
  assert.match(
    rendererSource,
    /class="weekday-chip \$\{\(event\.recurringDays \|\| \[\]\)\.includes\(day\) \? 'selected' : ''\}"/,
  );
  assert.match(
    rendererSource,
    /aria-pressed="\$\{\(event\.recurringDays \|\| \[\]\)\.includes\(day\)\}"/,
  );
});

test('weekday picker field is visible only for weekly recurring type', () => {
  assert.match(
    rendererSource,
    /data-recurring-weekday-field[\s\S]*?\$\{type === 'recurring' && event\.recurringType === 'weekly' \? '' : 'hidden'\}/,
  );
});

test('changing the recurring type toggles the weekday field visibility', () => {
  assert.match(
    rendererSource,
    /\$\$\('\[data-recurring-weekday-field\]', form\)\.forEach\(\(field\) => \{\s*field\.hidden = !weekly;\s*\}\)/,
  );
  assert.match(
    rendererSource,
    /const recurringType = form\.querySelector\('\[name="recurringType"\]'\)\?\.value \|\| 'daily';/,
  );
});

test('clicking a weekday chip toggles its selected state', () => {
  assert.match(
    rendererSource,
    /const weekdayChip = event\.target\.closest\('\[data-weekday\]'\);/,
  );
  assert.match(
    rendererSource,
    /const selected = weekdayChip\.classList\.toggle\('selected'\);/,
  );
  assert.match(
    rendererSource,
    /weekdayChip\.setAttribute\('aria-pressed', String\(selected\)\);/,
  );
});

test('saving a weekly recurring task persists the selected weekdays', () => {
  assert.match(
    rendererSource,
    /const selectedDays = \$\$\('\[data-weekday\]', form\)[\s\S]*?\.filter\(\(chip\) => chip\.classList\.contains\('selected'\)\)[\s\S]*?\.map\(\(chip\) => Number\(chip\.dataset\.weekday\)\)/,
  );
  assert.match(
    rendererSource,
    /recurringDays: recurringType === 'weekly' \? selectedDays : \[\],/,
  );
});

// ------------------------------------------------------------------ monthly day picker

test('detail dialog renders a 1-31 day picker for monthly recurring tasks', () => {
  assert.match(rendererSource, /data-monthday-picker/);
  assert.match(rendererSource, /Array\.from\(\{ length: 31 \}, \(_, index\) => index \+ 1\)/);
  assert.match(rendererSource, /data-monthday="\$\{day\}"/);
});

test('month day picker prefills existing days or the start day', () => {
  assert.match(
    rendererSource,
    /const monthDays = Array\.isArray\(event\.recurringMonthDays\) && event\.recurringMonthDays\.length[\s\S]*?\? event\.recurringMonthDays[\s\S]*?: \[parseDateKey\(baseDate\)\.getDate\(\)\]/,
  );
  assert.match(
    rendererSource,
    /class="weekday-chip \$\{monthDays\.includes\(day\) \? 'selected' : ''\}"/,
  );
});

test('month day picker field is visible only for monthly recurring type', () => {
  assert.match(
    rendererSource,
    /data-recurring-monthday-field[\s\S]*?\$\{type === 'recurring' && event\.recurringType === 'monthly' \? '' : 'hidden'\}/,
  );
});

test('changing recurring type toggles both weekday and month-day fields', () => {
  assert.match(
    rendererSource,
    /\$\$\('\[data-recurring-monthday-field\]', form\)\.forEach\(\(field\) => \{\s*field\.hidden = !monthly;\s*\}\)/,
  );
  assert.match(rendererSource, /const monthly = recurringTypeSelect\.value === 'monthly';/);
});

test('clicking a month-day chip toggles its selected state', () => {
  assert.match(
    rendererSource,
    /const monthdayChip = event\.target\.closest\('\[data-monthday\]'\);/,
  );
  assert.match(rendererSource, /monthdayChip\.classList\.toggle\('selected'\)/);
});

test('saving a monthly recurring task persists the selected day numbers', () => {
  assert.match(
    rendererSource,
    /const selectedMonthDays = \$\$\('\[data-monthday\]', form\)[\s\S]*?\.map\(\(chip\) => Number\(chip\.dataset\.monthday\)\)/,
  );
  assert.match(
    rendererSource,
    /recurringMonthDays: recurringType === 'monthly' \? selectedMonthDays : \[\],/,
  );
});

test('recurrence label shows monthly day numbers', () => {
  assert.match(
    rendererSource,
    /const days = \(event\.recurringMonthDays \|\| \[\]\)[\s\S]*?\.sort\(\(a, b\) => a - b\)/,
  );
  assert.match(rendererSource, /return days\.length \? `每月\$\{days\.join\('、'\)\}日` : '每月';/);
});

// ------------------------------------------------------------------ focus timer progress bar

test('task rows render a focus-timer progress bar between title and meta', () => {
  assert.match(
    rendererSource,
    /\$\{targetSeconds \? timerBarMarkup\(event\) : ''\}/,
  );
  assert.match(rendererSource, /data-timer-progress/);
  assert.match(rendererSource, /class="timer-progress-fill" style="width: \$\{pct\}%"/);
});

test('progress bar reads persisted timer state and caps at 100%', () => {
  assert.match(
    rendererSource,
    /const total = Math\.max\(1, targetDurationSecondsFor\(event\)\);/,
  );
  assert.match(
    rendererSource,
    /const pct = completed \? 100 : Math\.min\(100, Math\.round\(\(used \/ total\) \* 100\)\);/,
  );
  assert.match(
    rendererSource,
    /data-base-seconds="\$\{Number\(record\?\.elapsedSeconds\) \|\| 0\}"/,
  );
  assert.match(rendererSource, /data-completed="\$\{completed\}"/);
});

test('timer tick updates progress fills in real time and stops when paused', () => {
  assert.match(
    rendererSource,
    /\$\$\('\[data-timer-progress\]'\)\.forEach\(\(element\) => \{/,
  );
  assert.match(
    rendererSource,
    /const pct = element\.dataset\.completed === 'true'\s*\?\s*100\s*:\s*Math\.min\(100, Math\.round\(\(seconds \/ total\) \* 100\)\);/,
  );
  assert.match(rendererSource, /fill\.style\.width = `\$\{pct\}%`;/);
  assert.match(rendererSource, /setInterval\(updateTimerReadouts, 1000\)/);
});

// ------------------------------------------------------------------ long-term tasks & row timer control

test('detail dialog offers the long-term task type', () => {
  assert.match(rendererSource, /<option value="longterm" \$\{type === 'longterm' \? 'selected' : ''\}>长期任务<\/option>/);
  assert.match(
    rendererSource,
    /const type = event\.isLongTerm\s*\n\s*\? 'longterm'\s*\n\s*: \(event\.isDeadline \? 'deadline' : \(event\.isRecurring \? 'recurring' : 'normal'\)\);/,
  );
});

test('long-term tasks are labelled with their start date', () => {
  assert.match(
    rendererSource,
    /if \(event\.isLongTerm\) \{\s*const start = parseDateKey\(event\.startDate \|\| event\.date\);/,
  );
  assert.match(rendererSource, /return `长期任务 · 开始 \$\{dateText\} · \$\{calendar\}`;/);
});

test('saving a long-term task persists the flag and clears other types', () => {
  assert.match(
    rendererSource,
    /else if \(type === 'longterm'\) \{\s*Object\.assign\(updates, \{\s*isDeadline: false,\s*isRecurring: false,\s*isLongTerm: true,/,
  );
  assert.match(rendererSource, /isLongTerm: false,\s*date,/);
});

test('target duration input is HH:MM:SS and parses back to seconds', () => {
  assert.match(rendererSource, /name="targetDuration"[\s\S]*?type="text"/);
  assert.match(rendererSource, /placeholder="时:分:秒，如 01:30:00"/);
  assert.match(rendererSource, /const targetSeconds = parseDurationInput\(values\.targetDuration\);/);
  assert.match(rendererSource, /targetDurationSeconds: targetSeconds,/);
});

test('duration helpers convert between seconds and 时:分:秒', () => {
  assert.match(rendererSource, /function formatDurationInput\(seconds\) \{[\s\S]*?return formatElapsed\(Math\.floor\(seconds\)\);/);
  assert.match(rendererSource, /function parseDurationInput\(value\) \{[\s\S]*?if \(parts\.length === 3\) return parts\[0\] \* 3600 \+ parts\[1\] \* 60 \+ parts\[2\];/);
  assert.match(rendererSource, /if \(parts\.length === 2\) return parts\[0\] \* 60 \+ parts\[1\];/);
  assert.match(rendererSource, /function targetDurationSecondsFor\(event\) \{[\s\S]*?return Number\.isFinite\(minutes\) && minutes > 0 \? Math\.round\(minutes \* 60\) : 0;/);
});

test('task rows show a fixed start/pause control for tasks with a focus target', () => {
  assert.match(rendererSource, /timerRowControl\(event\)/);
  assert.match(rendererSource, /data-task-timer="\$\{escapeHtml\(event\.id\)\}"/);
  assert.match(rendererSource, /'<span class="timer-row-spacer" aria-hidden="true"><\/span>'/);
  assert.match(rendererSource, /icon\(running \? 'pause' : 'play'\)/);
});

test('row timer button click toggles the shared timer state', () => {
  assert.match(
    rendererSource,
    /const rowTimer = event\.target\.closest\('\[data-task-timer\]'\);\s*if \(rowTimer\) \{\s*toggleTimer\(rowTimer\.dataset\.taskTimer\);/,
  );
});

test('task meta shows the target duration in 时:分:秒', () => {
  assert.match(rendererSource, /\$\{icon\('timer'\)\} 目标 \$\{formatElapsed\(targetSeconds\)\}/);
});

test('task row grid reserves fixed hitbox columns for completion, timer and menu controls', () => {
  assert.match(stylesSource, /grid-template-columns: 34px 58px minmax\(0, 1fr\) 34px auto 34px;/);
  assert.match(stylesSource, /\.timer-row-button \{/);
  assert.match(stylesSource, /\.timer-row-spacer \{/);
});

// ------------------------------------------------------------------ live timer state (no stale snapshots)

test('progress bars and readouts carry event identity for live refreshes', () => {
  assert.match(rendererSource, /data-timer-event="\$\{escapeHtml\(event\.id\)\}"/);
  assert.match(rendererSource, /data-timer-date="\$\{dateKey\(state\.selectedDate\)\}"/);
  assert.match(rendererSource, /data-timer-event="\$\{escapeHtml\(event\.id\)\}"/);
});

test('timer tick reads the real timer record from the event store, not the render snapshot', () => {
  assert.match(
    rendererSource,
    /function liveTimerState\(element\) \{[\s\S]*?const eventId = element\.dataset\.timerEvent;[\s\S]*?if \(eventId && window\.eventAPI\?\.getTimerRecord\) \{[\s\S]*?const record = window\.eventAPI\.getTimerRecord\(eventId, date\) \|\| \{\};/,
  );
  assert.match(
    rendererSource,
    /\$\$\('\.timer-readout'\)\.forEach\(\(element\) => \{\s*const \{ seconds \} = liveTimerState\(element\);/,
  );
  assert.match(
    rendererSource,
    /\$\$\('\[data-timer-progress\]'\)\.forEach\(\(element\) => \{\s*const \{ seconds, running \} = liveTimerState\(element\);/,
  );
});

test('timer tick keeps the row start/pause button in sync with the real state', () => {
  assert.match(
    rendererSource,
    /const rowButton = element\.closest\('\.task-row'\)\?\.querySelector\('\[data-task-timer\]'\);/,
  );
  assert.match(
    rendererSource,
    /function syncRowTimerButton\(button, running\) \{[\s\S]*?button\.classList\.toggle\('running', running\);[\s\S]*?button\.innerHTML = icon\(running \? 'pause' : 'play'\);/,
  );
});

test('row timer button records its own event identity and running state', () => {
  assert.match(rendererSource, /data-timer-event="\$\{escapeHtml\(event\.id\)\}"/);
  assert.match(rendererSource, /data-timer-date="\$\{dateKey\(state\.selectedDate\)\}"/);
  assert.match(rendererSource, /data-running="\$\{running\}"/);
});

// ------------------------------------------------------------------ login persistence wiring

test('startup restores the session before sync can run', () => {
  const initCloud = preloadSource.match(/async function initCloud\(\) \{[\s\S]*?\n\}/);
  assert.ok(initCloud, 'initCloud should exist in preload');
  assert.match(initCloud[0], /syncEngine\.restoreSession\(\)/);
});

test('rotated refresh tokens are persisted through the credential store', () => {
  assert.match(preloadSource, /onRefreshToken:\s*\(token\) => credentialStore\.setRefreshToken\(token\)/);
  assert.match(preloadSource, /if \(!stored\) throw new Error\('无法安全保存登录凭据'\)/);
});

test('remote sync changes reload and redraw the visible calendar', () => {
  const subscription = rendererSource.match(/window\.cloudAPI\.subscribeState\(\(snapshot\) => \{[\s\S]*?\n\s*\}\);/);
  assert.ok(subscription, 'cloud state subscription should exist');
  assert.match(subscription[0], /previousDataRevision/);
  assert.match(subscription[0], /snapshot\.dataRevision/);
  assert.match(subscription[0], /renderAll\(\)/);
});

test('preload event bridge clears credentials on logout via signOut', () => {
  assert.match(preloadSource, /logout: async \(\) => \{[\s\S]*?syncEngine\.signOut\(\)/);
});

test('preload chat reset and approval bridge manage agent session state', () => {
  assert.match(preloadSource, /resetChat:\s*async[\s\S]*syncEngine\.resetAgentSession\(\)/);
  assert.match(preloadSource, /approveActions:\s*async[\s\S]*syncEngine\.approveActions[\s\S]*await syncEngine\.flushAgentReceipts\(\)/);
});

// ------------------------------------------------------------------ agent option groups

test('assistant chat bubbles opt back into text selection under the body-level user-select: none', () => {
  assert.match(stylesSource, /body\s*\{[^}]*user-select:\s*none;/);
  assert.match(stylesSource, /\.assistant-message\s*\{[^}]*user-select:\s*text;/);
});

test('approval card renders choice groups as unchecked radios and drops approve-all', () => {
  assert.match(rendererSource, /function groupApprovalActions\(actions\)/);
  assert.match(rendererSource, /const groupId = action\.choice_group_id;/);
  assert.match(rendererSource, /<input type="radio" class="approval-radio" name="\$\{radioPrefix\}-\$\{groupIndex\}" data-action-index="\$\{index\}">/);
  assert.match(rendererSource, /\$\{groups\.length \? `\s*<button class="primary-button approval-approve-selected">确认选择<\/button>/);
  assert.match(rendererSource, /querySelectorAll\('\.approval-check:checked, \.approval-radio:checked'\)/);
  assert.match(rendererSource, /results\[0\]\.type === 'invalid_choice'/);
  assert.match(stylesSource, /\.approval-option:has\(\.approval-radio:checked\)/);
});

test('single-occurrence edits are labelled on task rows, details and approval cards', () => {
  assert.match(rendererSource, /if \(event\.hasOccurrenceOverride\) \{[\s\S]*?本次已调整/);
  assert.match(rendererSource, /function occurrenceNoteMarkup\(event\)/);
  assert.match(rendererSource, /\$\{occurrenceNoteMarkup\(event\)\}/);
  assert.match(rendererSource, /action\.scope === 'single'\s*\? `仅 \$\{action\.effective_date \|\| '今天'\} 这一次/);
  assert.match(stylesSource, /\.detail-occurrence-note\s*\{/);
});
