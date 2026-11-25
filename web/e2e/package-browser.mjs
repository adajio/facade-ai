// Browser portion of the opt-in PostgreSQL package scenario. The same API and
// database serve the UI while the test provides controlled reader publications.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chromium, expect as assertBrowser } from '@playwright/test';
import { createApi } from '../../dist/src/platform/api.js';
import { readConfig } from '../../dist/src/platform/config.js';

const expect = assertBrowser.configure({ timeout: 25_000 });

export async function openPackageBrowser() {
  const server = await createApi(readConfig());
  let browser;
  try {
    const origin = await server.listen({ port: 0, host: '127.0.0.1' });
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await chromium.launch({executablePath: process.env.FACADE_CHROME_PATH ?? (existsSync(chrome) ? chrome : undefined)});
    const serverFailures = [];
    async function newPage() {
      const page = await browser.newPage({baseURL: origin});
      page.on('response', response => {
        if (response.status() >= 500) serverFailures.push([response.status(), response.request().method(), new URL(response.url()).pathname]);
      });
      return page;
    }
    let page = await newPage();
    async function command(path, method, data, version) {
      const me = await page.request.get('/api/me');
      const { csrfToken } = await me.json();
      const response = await page.request.fetch(path, { method, data, headers: { Origin: origin,
        'X-CSRF-Token': csrfToken, 'Idempotency-Key': randomUUID(),
        ...(version === undefined ? {} : { 'If-Match': '"' + version + '"' }),
      } });
      await expect(response).toBeOK();
      return response.json();
    }
    return {
      origin,
      async createProject(login, password, name) {
        await page.goto('/login');
        await page.getByLabel('Логин').fill(login);
        await page.getByLabel('Пароль', {exact: true}).fill(password);
        await page.getByRole('button', {name: 'Войти', exact: true}).click();
        await page.getByRole('button', {name: 'Создать проект'}).click();
        await page.getByLabel('Название проекта').fill(name);
        const [response] = await Promise.all([
          page.waitForResponse((r) => new URL(r.url()).pathname === '/api/projects' && r.request().method() === 'POST'),
          page.getByRole('button', {name: 'Сохранить проект'}).click(),
        ]);
        expect(response.status()).toBe(201);
        await expect(page).toHaveURL(/\/projects\/[^/]+\/overview$/);
        const projectPath = new URL(page.url()).pathname.replace(/\/overview$/, '');
        const saved = await page.request.get('/api' + projectPath);
        await expect(saved).toBeOK();
        const project = await saved.json();
        expect(project.name).toBe(name);
        const engineer = 'package-engineer-' + randomUUID().slice(0, 8);
        const passwordForEngineer = 'Engineer-' + randomUUID();
        const invitation = await command('/api/users/invitations', 'POST', {login: engineer});
        const joined = await page.request.post('/api/invitations/complete', {
          data: {token: invitation.token, password: passwordForEngineer}, headers: {Origin: origin},
        });
        await expect(joined).toBeOK();
        const grant = await command('/api' + projectPath + '/members/' + invitation.userId, 'PUT', {role:'engineer'}, project.version);
        await page.close();
        page = await newPage();
        await page.goto('/login');
        await page.getByLabel('Логин').fill(engineer);
        await page.getByLabel('Пароль', {exact:true}).fill(passwordForEngineer);
        await page.getByRole('button', {name:'Войти',exact:true}).click();
        await expect(page.getByRole('link', {name:new RegExp(name)})).toBeVisible();
        return {...project, version: grant.version};
      },
      async openInventory(projectId, receiptId) {
        await page.goto('/projects/' + projectId + '/receipts/' + receiptId);
        await expect(page.getByRole('row').filter({hasText:'first.pdf'})).toBeVisible();
        await expect(page.getByRole('row').filter({hasText:'inventory.pdf'})).toBeVisible();
      },
      async reviewConflict(projectId, area, question) {
        await page.goto('/projects/' + projectId + '/completeness/' + question.id + '?context=' + area);
        const sources = [...new Map(question.machine.citations.map(citation => [citation.versionId, citation])).values()];
        expect(sources.length).toBeGreaterThanOrEqual(2);
        for (const source of sources) {
          await page.getByRole('button', {name: new RegExp(' · ' + source.value + ' ' + source.unit + '$')}).first().click();
          const panel = page.getByRole('region', {name:'Оригинал и основание'});
          await expect(panel).toContainText(source.versionId);
          await expect(panel.locator('blockquote')).toContainText(question.requirement.part);
          await panel.getByRole('button', {name:'Закрыть просмотр оригинала'}).click();
        }
        const form = page.locator('form').filter({has:page.getByLabel('Действие по требованию')});
        await form.getByLabel('Основание решения').fill('Проверены адреса двух исходных документов');
        await form.getByLabel('Добавить во внешние основания').check();
        const [response] = await Promise.all([
          page.waitForResponse(r => r.url().endsWith('/questions/' + question.id + '/decisions') && r.request().method()==='POST'),
          form.getByRole('button', {name:'Сохранить решение по требованию'}).click(),
        ]);
        expect(response.status()).toBe(201);
        const decision = await response.json();
        return decision;
      },
      async conclude(projectId, area, evidenceId) {
        await page.goto('/projects/'+projectId+'/completeness?context='+area+'&panel=conclusion');
        const form=page.locator('form').filter({has:page.getByLabel('Можно ли начать работы')});
        await form.getByLabel('Можно ли начать работы').selectOption('cannot_start');
        await form.getByLabel('Основание решения', {exact:true}).fill('До разрешения подтверждённых расхождений начать работы нельзя.');
        await form.getByLabel('Основание заключения по материалам').selectOption('citation');
        await form.getByRole('combobox', {name:'Источник',exact:true}).selectOption(evidenceId);
        const [response]=await Promise.all([
          page.waitForResponse(r=>r.url().endsWith('/conclusions') && r.request().method()==='POST'),
          form.getByRole('button',{name:'Сохранить заключение'}).click(),
        ]);
        expect(response.status()).toBe(201);
        await page.reload();
        await expect(page.getByText(/До разрешения подтверждённых расхождений/)).toBeVisible();
      },
      async createLetter(projectId, area, recipient, questions, otherArea) {
        const projectPath = '/projects/' + projectId;
        await page.goto(projectPath + '/overview?context=' + area);
        await expect(page.locator('summary[aria-current="step"]')).toContainText('5. Переписка');
        await page.getByRole('link', {name:'Открыть письма и основания'}).click();
        await expect(page).toHaveURL(new RegExp('context=' + area));
        const recipientField = page.getByRole('combobox', {name:'Адресат',exact:true});
        await expect(recipientField).toBeVisible();
        await recipientField.selectOption(recipient);
        const boxes = page.locator('form input[type="checkbox"]');
        await expect(boxes).toHaveCount(questions.length);
        for (const q of questions) await page.getByRole('checkbox', {name: new RegExp(q.requirement.part, 'i')}).check();
        const [response] = await Promise.all([
          page.waitForResponse((r) => r.url().endsWith('/letters') && r.request().method() === 'POST'),
          page.getByRole('button', {name: 'Создать письмо из выбранных пунктов'}).click(),
        ]);
        expect(response.status()).toBe(201);
        await expect(page).toHaveURL(/\/letters\/[^/?]+/);
        const letterId = new URL(page.url()).pathname.split('/').at(-1);
        const saved = await page.request.get('/api/v1/letters/' + letterId);
        await expect(saved).toBeOK();
        const letter = await saved.json();
        for (const q of questions) await expect(page.getByTestId('current-letter-text')).toContainText(q.requirement.part);
        await page.goto(projectPath + '/letters?context=' + otherArea);
        await expect(page.getByRole('link', {name:'Проверить комплектность'})).toBeVisible();
        return letter;
      },
      async recordSending(projectId, area, letter, text) {
        await page.goto('/projects/' + projectId + '/letters/' + letter.id + '?context=' + area);
        await page.getByRole('button', {name:'Зафиксировать отправку'}).click();
        await expect(page.getByLabel('Фактически отправленный текст')).toHaveValue(text);
        await page.getByLabel('Когда отправлено').fill('2026-11-24T12:00');
        const response = page.waitForResponse(r => r.url().endsWith('/sent') && r.request().method() === 'POST');
        await page.getByRole('button', {name:'Сохранить факт отправки'}).click();
        const saved = await response;
        expect(saved.status()).toBe(201);
        await expect(page).toHaveURL(/[?&]sent=[a-f0-9-]+/);
        const sentId = new URL(page.url()).searchParams.get('sent');
        return {id:sentId, url:'/api/v1/letters/' + letter.id + '/sent/' + sentId};
      },
      async replaceSources(projectId, area, row, replacements, previous) {
        await page.goto('/projects/' + projectId + '/completeness/' + row.id + '?context=' + area);
        const form = page.getByRole('region', {name:'Сверка досылки по требованию'});
        for (const source of [...replacements, ...previous]) {
          await form.locator('input[type="checkbox"][value="' + source.observationId + '"]').check();
        }
        await form.getByLabel('Причина сверки').fill('Проверены адреса новых редакций того же требования.');
        await form.getByLabel('Подтверждаю выбранные опоры этого требования').check();
        const response = page.waitForResponse(r => r.url().endsWith('/source-replacements') && r.request().method() === 'POST');
        await form.getByRole('button', {name:'Подтвердить замену опор'}).click();
        expect((await response).status()).toBe(201);
      },
      async checkHistory(projectId, area, letter, sent, originalText) {
        await page.goto('/projects/' + projectId + '/letters/' + letter.id + '?context=' + area + '&sent=' + sent.id);
        await expect(page.getByRole('heading', {name:'История · снимок отправки'})).toBeVisible();
        await expect(page.locator('pre')).toHaveText(originalText);
        await page.reload();
        await expect(page.locator('pre')).toHaveText(originalText);
      },
      async close() {
        try { await browser.close(); } finally { await server.close(); }
        expect(serverFailures).toEqual([]);
      },
    };
  } catch (error) {
    try { await browser?.close(); } finally { await server.close(); }
    throw error;
  }
}
