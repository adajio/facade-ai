export const sections = {
  overview: 'Обзор',
  receipts: 'Поступления',
  completeness: 'Комплектность',
  facts: 'Сведения',
  fragments: 'Фрагменты',
  copilot: 'Помощник',
  questions: 'Вопросы',
  letters: 'Письма',
  members: 'Участники',
  settings: 'Настройки проекта',
} as const;

export type Section = keyof typeof sections;
export type Route = {
  page: 'login' | 'reset' | 'invite' | 'projects' | 'project' | 'admin' | 'operator' | 'missing';
  projectId?: string;
  section?: Section;
  objectId?: string;
  params: URLSearchParams;
};

export function readRoute(location: Pick<Location, 'pathname' | 'search'> & { hash?: string }): Route {
  const params = new URLSearchParams(location.search);
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts.length === 0) return { page: 'projects', params };
  const [first, project, section = 'overview', object] = parts;
  if (first === 'invite' || first === 'password-reset') {
    const token = new URLSearchParams(location.hash?.slice(1)).get('token');
    if (token) params.set('token', token);
  }
  switch (first) {
    case 'login': return { page: 'login', params };
    case 'password-reset': return { page: 'reset', params };
    case 'invite': return { page: 'invite', params };
    case 'admin': return { page: 'admin', params };
    case 'operator': return { page: 'operator', params };
    case 'projects':
      if (!project) return { page: 'projects', params };
      if (Object.hasOwn(sections, section)) {
        try {
          return {
            page: 'project', projectId: decodeURIComponent(project), section: section as Section,
            objectId: object && decodeURIComponent(object), params,
          };
        } catch {
          return { page: 'missing', params };
        }
      }
  }
  return { page: 'missing', params };
}

export function projectUrl(projectId: string, section: Section = 'overview', objectId?: string) {
  return '/projects/' + encodeURIComponent(projectId) + '/' + section +
    (objectId ? '/' + encodeURIComponent(objectId) : '');
}

export function returnPath(value: string | null) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/projects';
  const url = new URL(value, window.location.origin);
  if (url.origin !== window.location.origin || ['/login', '/invite', '/password-reset'].includes(url.pathname)) {
    return '/projects';
  }
  return url.pathname + url.search;
}
