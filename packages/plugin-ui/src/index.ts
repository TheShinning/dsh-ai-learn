/**
 * 伴学插件的**宿主半边**（node half）。
 *
 * 纯 UI 插件在宿主侧必须存在一个空 `apply`：`dsh-client-modules` 是按
 * **Loader entry → 解析 package.json → 找 `dsh.client`** 来发现客户端包的，
 * 所以没有这一行，浏览器半边根本不会被组合进 `window.__DSH_BOOT__`。
 *
 * 对照 DSH 自带的 `dsh-client-ui-goal/lib/index.js`（同样的空 apply + 同样的注释）。
 */
export function apply(): void {
  // 宿主侧无行为；伴学宿主逻辑在同仓库的 `@dsh-study/plugin-host` 里。
}
