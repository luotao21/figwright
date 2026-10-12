# 检查规则与证据

读取本次适用的类别。rule ID 用于稳定记录问题和跟踪复查结果。
按节点职责、项目规范及可取得的证据选择检查项；每条规则都要有实际依据，不能因表中存在就判错。

## 排版与内容

| rule ID                    | 读取／检查                                                                     | 判断边界                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `font-family`、`font-size` | 角色对应的 text style、fontName、fontSize、lineHeight、letterSpacing、segments | 同职责对比；混合文字按 run 检查。标题和正文不需要同字号。                                      |
| `copy`                     | characters、textOverrides、实例 TEXT 属性与批准文案                            | 以项目批准的文案为准；不按个人措辞偏好批量重写。                                               |
| `tabular-numbers`          | 变化数值的字体、样例和对齐规范                                                 | 当前工具未给出数字特性时，不能由等宽字体名或截图断言启用了 tabular figures。没有证据记待核实。 |
| `numeric-alignment`        | 同职责数值列的公共边、单位／小数位置                                           | 按阅读任务检查；不同类型数字不强制右对齐。                                                     |
| `design-text-flow`         | textAutoResize、textTruncation、maxLines、paragraphSpacing、容器宽度与新截图   | 区分已设计的省略和误截断；保留富文本、链接和列表。静态高度不足以证明所有长文案都适配。         |

必要长文案／数字／语言从真实内容或已有样例取得。纯检查不改稿来生成测试内容；缺少样例时明确待测。
优化时可在允许范围内使用临时副本试验，保持原内容，并按授权处理副本。不要用假数据充当最终产品内容。

## 布局与几何

| rule ID                                  | 读取／检查                                                                                   | 判断边界                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `control-size`、`target-size`            | 控件／原型触发对象的实际边界、必要的交接规格                                                 | 图标边界不等于点击目标。声明 Figma 单位到 CSS px 的映射后才可给出 Web 无障碍阈值结论。 |
| `control-gap`、`layout-gap`              | 语义分组、layout.mode、gap／itemSpacing、wrap、counterAxisSpacing、gridRowGap／gridColumnGap | 测量同一行／列的相邻对象；有意叠放的头像、插画不按负 gap 判错。                        |
| `control-inset`                          | 控件所属容器的四边 padding、描边、子级留白、定位                                             | 读取真正承担留白的容器；修父级而不是给每个子级伪造 margin。                            |
| `layout-alignment`                       | 同职责对象的公共起始／中心／结束边、baseline 及父级 alignment                                | 不比较无共同对齐职责的任意节点；文字基线和包围框中心是不同关系。                       |
| `nested-radius`                          | 同心外／内表面的逐角 radius、inset、strokeAlign／strokeWeight、cornerSmoothing               | 仅等距、圆形圆角的嵌套适用减法；非等距、胶囊、异形或平滑圆角不机械套公式。             |
| `horizontal-overflow`、`viewport-bounds` | 目标画板内容边界、width、min/max、约束、必要祖先和截图                                       | 画布上画板之间的距离不代表网页溢出；横向轮播等需检查设计的滚动入口。                   |
| `content-clipping`、`content-overflow`   | clipsContent、mask、文本裁剪、overflowDirection、固定子级和截图                              | 区分必要裁剪、可达滚动和误隐藏；画板高度不是页面必须固定的高度。                       |
| `design-sizing`                          | HUG/FILL/FIXED、layoutGrow／layoutAlign、constraints、gridChild                              | 检查实际父子布局条件；保留已有 GRID、wrap、绝对装饰层与比例约束。                      |

### 测量关系

以已确认的坐标系和单位计算。原始 `get_node` 的 x/y 相对父级，不包含足以还原任意嵌套变换的全部信息。
只有共同父级且无影响计算的变换，或已取得可靠变换时，才直接比较边界。旋转／缩放证据不足则降为可见现象／待核实。
使用项目容差；未定义时注明测量精度，不把测量噪声误判为规范偏差。

- 同一行且纵向相交的相邻目标：`gap = next.left - previous.right`；同一列同理。
- 可见组间距离可能来自前组底部留白、父级 gap、后组顶部留白或绝对偏移。只计算实际生效的贡献。
  `SPACE_BETWEEN` 等分布会增大实际间距，单读 itemSpacing 不能证明可见 gap。
- 等距圆角嵌套：`innerRadius = max(0, outerRadius - inset)`。inset 与 radius 使用同一边界定义，包含描边占位。
- 自然高度要求存在时，检查从内容到根的固定高度／maxHeight／裁剪链；只给最内层 HUG 可能仍被祖先裁掉。

### 点击目标基准

Web WCAG 2.2 AA 的 `target-size` 通常要求至少 24×24 CSS px，并有间距、等价目标、行内、用户代理和必要性例外。
间距例外用以小目标边界中心为圆心、直径 24px 的圆判断：不能与其它目标或其它小目标对应圆相交。
44×44 常用于更高等级或项目触控规范，不是通用 AA 阈值。
原生平台按项目平台规范检查。画布缩放、设备像素和设计单位不能混为 CSS px。

## 颜色与可读性

| rule ID                 | 读取／检查                                                                                 | 判断边界                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `root-background`       | 画板 fills、必要祖先、有效变量模式与截图                                                   | Figma 页面底色、画板填充和网页 html 背景不同；合法透明稿不按 HTML 默认规则判错。 |
| `text-contrast`         | 真实前景／背景、字号／字重、paint opacity、节点及祖先 opacity、blendMode                   | 不从抗锯齿文字或 token 名称猜比值；图片、渐变、滤镜与叠层需可靠合成证据。        |
| `design-state-contrast` | 表达状态必需的图形、边框、图标及背景                                                       | WCAG AA 适用的非文字信息通常至少 3:1；按实际条款和例外，区分文本与非文本。       |
| `design-theme-binding`  | 当前 resolved mode、explicitVariableModes／variableModes、styleIds 和 paint／node bindings | 默认模式值不代表 Dark 等其它模式；值相同不代表绑定或语义正确。                   |

普通文字 AA 至少 4.5:1，大文字至少 3:1。Web 大文字通常为至少 24 CSS px，或至少约 18.67 CSS px 且为粗体。
未确认单位映射／实际字重时不套大字例外。占位文字不会因为“辅助”自动降低标准；禁用控件和 logo 等按条款说明例外。
规范与无障碍基准冲突时分别报告，不宣称两者同时通过。

纯色计算：sRGB 通道归一化为 0–1；`c <= 0.04045` 时取 `c / 12.92`，否则取 `((c + 0.055) / 1.055)^2.4`。
`L = 0.2126R + 0.7152G + 0.0722B`，比值为 `(lighterL + 0.05) / (darkerL + 0.05)`，用未舍入结果判断。
透明前景先与实际背景合成；复杂合成不能用简单乘 opacity 替代。图片／渐变检查文字覆盖区域的最低对比度，
证据不足记待核实，不改掉资产来让检查更容易。

## 组件、操作与必要状态

| rule ID                                                                 | 设计阶段可验证内容                                                                                   | 实现阶段待测                                                                         |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `design-component-integrity`                                            | mainComponent、componentProperties、公开 API、覆盖、styleIds／boundVariables；同职责组件的实际一致性 | 代码复用和最终组件行为。相同值的未绑定对象，只有项目要求绑定或语义已证实时才判偏差。 |
| `accessible-name`、`form-label`、`label-consistency`                    | 控件用途、持续可识别标签、可见名称及交接规格                                                         | computed accessible name、label／ARIA 和读屏；纯图标需名称规格，tooltip 不能替代。   |
| `aria-reference`、`control-state`                                       | 标签／描述／错误／受控内容的关系；选择、展开、禁用等必要状态                                         | DOM ID 存在性与状态更新。静态稿没有 DOM 不代表设计关系不存在，也不证明程序关联通过。 |
| `keyboard-operation`、`focus-visible`、`focus-obscured`、`dialog-focus` | 焦点样式、遮挡风险、初始焦点／退出／返回说明                                                         | 真实键盘操作、焦点进入／约束／返回、滚动与遮挡。                                     |
| `icon-button-tooltip`                                                   | 项目要求的 hover／focus 提示、触屏下可理解的用途                                                     | tooltip 的实际可达性和程序关联；不为所有触屏图标机械补 hover。                       |
| `design-state-coverage`                                                 | 该流程需要的 loading、empty、error、success、长内容与权限状态，可复用已有组件说明                    | 真实数据、网络、权限和动态状态；不新增任务未要求的业务流程或画板。                   |
| `design-hierarchy`                                                      | 主要目标／操作、标题与正文关系、阅读顺序、分组密度、同职责一致性                                     | 定性判断写出用户影响，缺少规范时属于建议，不能输出伪造分数。                         |

有原型时 `get_reactions` 可检查已有跳转／触发定义；它不证明真实键盘或读屏行为。
Motion 的摘要与 dedupe 可能遗漏细节；修改相关对象时按需读取 `get_motion_context`，保留现有动效，
不能把 `design_diff` 的 `no-changes` 当作动效完全相同。
`font-loading` 是网页运行时规则；Figma 能否使用字体与网络字体能否加载分开验证。
