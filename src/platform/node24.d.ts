// Available in the deployment runtime. TypeScript 5.9's standard library omits it.
interface RegExpConstructor {
  escape(value: string): string
}
