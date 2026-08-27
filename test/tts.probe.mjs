// 语音播报探针：从 public/app.js 源码中提取 mdToSpeech / splitSpeech 实测
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const grab = (name) => {
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`));
  if (!m) throw new Error(`未找到 ${name}`);
  return m[0];
};
const factory = new Function(`${grab('mdToSpeech')}\n${grab('splitSpeech')}\nreturn { mdToSpeech, splitSpeech };`);
const { mdToSpeech, splitSpeech } = factory();

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.error(`FAIL: ${name}`); } };

// 1. 语法符号剥离：加粗/斜体/标题/列表
{
  const out = mdToSpeech('## 标题\n- **重点** 和 *斜体*\n1. 第一项');
  check('标题井号去除', !out.includes('#'));
  check('加粗星号去除', out.includes('重点') && !out.includes('**'));
  check('斜体星号去除', out.includes('斜体'));
  check('列表标记去除', !/^- /m.test(out) && !/^1\. /m.test(out));
}
// 2. 代码块不读、行内代码保留内容
{
  const out = mdToSpeech('前面 ```\nconst secret = 1;\n``` 后面跑 `npm test` 即可');
  check('围栏代码块不读', !out.includes('secret'));
  check('行内代码保留内容', out.includes('npm test') && !out.includes('`'));
}
// 3. 链接只读文字
{
  const out = mdToSpeech('看 [文档](https://example.com/a?b=1) 这里');
  check('链接读 label', out.includes('文档') && !out.includes('example.com') && !out.includes(']('));
}
// 4. 表格：无竖线、无分隔行，单元格顿号连读
{
  const out = mdToSpeech('| 语法 | 结果 |\n| --- | --- |\n| **加粗** | 生效 |');
  check('表格无竖线', !out.includes('|'));
  check('表格无分隔符', !out.includes('---'));
  check('表格单元格连读', out.includes('加粗，生效'));
}
// 5. [runner] 续跑提示行不读
{
  const out = mdToSpeech('[runner] kimi 正常结束\nTo resume this session: kimi -r abc');
  check('续跑提示去除', !out.includes('resume this session'));
}
// 6. 分句：句读+换行拆分
{
  const parts = splitSpeech('第一句。第二句！\n第三句？');
  check('按句拆分', parts.length === 3 && parts[0] === '第一句。' && parts[2] === '第三句？');
}
// 7. 超长句按逗号再拆（无句读长句 >120 字）
{
  const long = Array.from({ length: 30 }, (_, i) => `第${i}段内容内容内容内容`).join('，');
  const parts = splitSpeech(long);
  check('长句再拆', parts.length > 3 && parts.every((p) => p.length <= 30));
}
// 8. 空输入 / 全代码块 → 空结果（按钮 toast 路径）
{
  check('空输入空结果', splitSpeech(mdToSpeech('')).length === 0);
  check('纯代码块空结果', splitSpeech(mdToSpeech('```\ncode\n```')).length === 0);
}

console.log(`pass ${pass} / fail ${fail}`);
process.exit(fail ? 1 : 0);
