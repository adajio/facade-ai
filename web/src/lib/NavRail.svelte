<script lang="ts">
  import { available, type Project } from './contracts';
  import { sections, type Section } from './routes';
  import { formatBudget, type CopilotBudget } from './copilot';

  let { project, section, collapsed, toggle, link, counts, budget }: {
    project: Project; section: Section; collapsed: boolean; toggle: () => void;
    link: (section: Section) => string; counts: Partial<Record<Section, number>>; budget?: CopilotBudget;
  } = $props();
  const groups: { label: string; items: Section[] }[] = [
    { label: 'Приёмка', items: ['overview', 'receipts'] },
    { label: 'Проверка', items: ['completeness', 'fragments'] },
    { label: 'Переписка', items: ['letters'] },
    { label: 'Помощник', items: ['copilot'] },
    { label: 'Управление', items: ['members'] },
  ];
  const icons: Partial<Record<Section, string>> = {
    overview: '▦', receipts: '↓', completeness: '✓', fragments: '▧', letters: '✉', copilot: '✧', members: '◎',
  };
  const current = $derived(section === 'facts' || section === 'questions' ? 'completeness' : section);
  let mobile = $state(false);
  function visible(item: Section) {
    return (!project.scopeId || item === 'fragments' || item === 'copilot') &&
      (item !== 'members' || available(project, 'project:manage'));
  }
</script>

<aside class:collapsed class:mobile class="rail">
  <button class="quiet mobile-toggle" type="button" aria-expanded={mobile} aria-controls="project-sections"
    onclick={() => mobile = !mobile}>Разделы · {sections[current]}</button>
  <nav id="project-sections" aria-label="Разделы проекта">
    {#each groups as group}
      {#if group.items.some(visible)}
        <div class:management={group.label === 'Управление'} class="nav-group" role="group" aria-label={group.label}>
          {#if group.label !== 'Помощник'}<span class="group-title" aria-hidden="true">{group.label}</span>{/if}
          {#each group.items.filter(visible) as item (item)}
            {@const count = counts[item]}
            {@const remainder = item === 'copilot' && budget?.state === 'ready' ? budget.remainingUsdNanos : undefined}
            {@const budgetLabel = remainder === undefined ? undefined : formatBudget(remainder)}
            {@const label = sections[item] + (count ? ' · ' + count : budgetLabel ? ' · остаток ' + budgetLabel : '')}
            <a href={link(item)} aria-current={item === current ? 'page' : undefined}
              aria-label={label} title={label} onclick={() => mobile = false}>
              <span class="icon" aria-hidden="true">{icons[item]}</span><span class="name">{sections[item]}</span>
              {#if count}<span class="count" class:attention={item === 'completeness'} aria-hidden="true">{count}</span>{/if}
              {#if remainder !== undefined && budget?.state === 'ready'}
                <span class="count" class:attention={remainder < budget.limitUsdNanos / 5} aria-hidden="true">{budgetLabel}</span>
              {/if}
            </a>
          {/each}
        </div>
      {/if}
    {/each}
  </nav>
  <button class="quiet rail-toggle" type="button" aria-expanded={!collapsed} aria-controls="project-sections"
    title={collapsed ? 'Развернуть меню' : 'Свернуть меню'} onclick={toggle}>
    <span aria-hidden="true">{collapsed ? '›' : '‹'}</span><span class="name">Свернуть меню</span>
  </button>
</aside>

<style>
  .rail { align-self: start; position: sticky; top: 52px; height: calc(100dvh - 52px); display: flex; flex-direction: column;
    padding: 16px 12px 8px; background: var(--surface); border-inline-end: 1px solid var(--line); }
  nav { flex: 1; display: flex; flex-direction: column; gap: 16px; overflow: auto; padding: 4px; }
  .nav-group { display: grid; gap: 2px; }
  .group-title { color: var(--muted); font-size: .78rem; font-weight: 700; padding-inline: 8px; }
  .management { margin-top: auto; }
  a { display: flex; align-items: center; min-height: 40px; gap: 8px; padding: 4px 8px; border-radius: 6px;
    color: var(--ink); text-decoration: none; font-weight: 580; }
  a[aria-current] { background: #e5f2ef; color: var(--accent-text); font-weight: 700; }
  a:hover { background: var(--field); }
  .icon { flex: 0 0 20px; text-align: center; font-size: 1.22rem; color: var(--accent-text); }
  .count { margin-inline-start: auto; font-variant-numeric: tabular-nums; font-size: .8rem; color: var(--accent-text); }
  .attention { color: var(--warn-text); }
  .rail-toggle { justify-content: start; gap: 8px; padding: 4px 8px; }
  .rail-toggle > span:first-child { text-align: center; min-width: 20px; font-size: 1.35rem; }
  .mobile-toggle { display: none; }
  @media (min-width: 851px) {
    .collapsed { padding-inline: 3px; }
    .collapsed .name, .collapsed .group-title, .collapsed .count { display: none; }
    .collapsed a, .collapsed .rail-toggle { justify-content: center; padding-inline: 0; }
  }
  @media (min-width: 851px) and (max-width: 1140px) { .rail-toggle { display: none; } }
  @media (max-width: 850px) {
    .rail { position: static; height: auto; padding: 4px 12px; border: 0; border-bottom: 1px solid var(--line); }
    .mobile-toggle { display: inline-flex; align-self: start; }
    nav, .rail-toggle { display: none; }
    .mobile nav { display: flex; flex-flow: row wrap; gap: 8px 16px; }
    .management { margin-top: 0; }
  }
</style>
