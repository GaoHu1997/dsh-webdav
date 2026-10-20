# 0037 请求头字段不再带说明，示例改成两行

- 状态：已接受
- 日期：2026-10-20

## 背景

[0034](0034-extra-request-headers.md) 给「服务器」小节加了额外请求头字段，落成三件东西：标签「额外请求头」、标签下一句说明 `headersHint`（「一行一个「名字: 值」，随每个请求发给服务器；反向代理要的鉴权头可以写在这里。」）、三行高的 textarea，占位符 `X-Header: 值`。

用户 2026-10-20 看过之后提了两条（原话）：

1. 「移除说明」—— 指的就是那句 `headersHint`。
2. 「如果以一行一个值，多个是多行，那么框内的示例就应该写两个以上，不然不知道怎么写」—— 指占位符只有一个 `X-Header: 值`，而字段的真实用法是「一行一个、可以叠多行」，一个样例反而让人以为只填一条。

第二条是本条的真正理由：那段说明讲的是「一行一个」这条格式规则，而一句「一行一个」是拿文字去描述形状；直接给两行示例，形状本身就在占位符里，不需要再描述一遍。删掉说明不是嫌它长，是它被示例取代了。

## 决策

**删掉 `headersHint`**：`WebdavSyncKey` 联合类型里的一行、`zh` 与 `en` 各一条、`WebdavSyncCard.tsx` 里那个 `<p className={css.fieldHint}>{t('headersHint')}</p>`。textarea 直接跟在 `<label>` 后面。

**占位符给两行**，两种语言同一个值：

```ts
headersPlaceholder: 'User-Agent: Zotero/7.0\nAuthorization: Bearer xxxxx',
```

选这两个例子而不是随手挑两个 `X-Header: 值` 的复数版，是因为它们正好覆盖 0034 已经写下、README 也讲过的两条最容易被误解的用法：

- `User-Agent` —— 有的服务器（例如 CSTCloud `data.cstcloud.cn`）按客户端类型放行，不带它一律 `403 Client type mismatch.`；
- `Authorization: Bearer …` —— 0034 的那条例外（给了自己的 `authorization` 就不再补 Basic），两行示例摆在一起也就顺带说出「这一栏可以接管认证」。

`\n` 是字符串里的换行，textarea 的 `placeholder` 原样渲染成两行，所以示例里读到的形状和用户该写的形状是同一个。

`.fieldHint` 这个类**留着**：口令字段还在用它（`passphraseHint`），只是请求头这一处不再调用。

被否决的备选：

- **保留说明、只把示例改成两行**。用户明确说了「移除说明」，而且说明与示例讲的是同一件事（「一行一个」/ 两行示例），留一句是在用文字复述旁边的形状，与 [0031](0031-card-layout-and-chinese-messages.md) 的判据（一句话若不改变用户接下来的动作，就不留在卡片上）相悖。
- **说明改短成「一行一个」四个字**。还是那句复述，只是更省地方。
- **示例用 `<name>: <value>` / `<name>: <value>` 这种占位式写法**。两行一模一样，读者会以为要填同名两遍；实数示例才说明「每行一个不同的头」。
- **把说明搬进 placeholder 之外的位置（悬浮提示、帮助链接）**。这个字段的全部格式信息只有格式本身，藏起来只会多一次点击。

## 影响

正面：

- 「服务器」小节从上到下是「地址 / 用户名、密码 / 口令（带说明）/ 额外请求头」，「每句说明都紧跟在它讲的那个字段的标签下面」这条 README 描述仍然准确 —— 现在只有口令字段有说明。
- 多行这件事在输入框里直接看得见，用户不必先读一句话再想象它。
- 卡片少一行字，与 [0033](0033-password-checkbox-on-its-field.md) 删掉「保存密码」那句说明同一方向。

负面：

- **「空行与 `#` 开头的行被忽略」「名字按 HTTP token 规则校验、坏行带行号报错」这两条格式细节不再出现在卡片上**。它们仍写在 README 的「额外请求头」一节（第 128 行）与 0034 里；坏行仍会在保存时按行号报错，所以出错时用户拿得到线索，只是事前不再预告。
- 占位符在用户开始输入后即消失，两行示例也就消失。它只在空字段时起作用，这一点和任何 placeholder 一样。
- 改动只落在浏览器半边，`lib/client.js` 是构建产物：已经装到机器上的旧版本要重新发布或重装才会看到。

## 相关

- `src/client/locales.ts` —— `WebdavSyncKey` 去掉 `headersHint`，`headersPlaceholder` 改为两行示例。
- `src/client/WebdavSyncCard.tsx` —— 删掉那个 `<p className={css.fieldHint}>`。
- `docs/decisions/0034-extra-request-headers.md` —— 这个字段本身的解析、合并顺序与 `authorization` 例外。
- `docs/decisions/0031-card-layout-and-chinese-messages.md` —— 「不改变动作的话不留」的判据。
- `docs/decisions/0033-password-checkbox-on-its-field.md` —— 上一次删掉字段说明的先例。
