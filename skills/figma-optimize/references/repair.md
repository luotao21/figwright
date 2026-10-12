# Figwright 修复与验证

仅在用户要求优化／修复时读取本文件。工具名以不带 MCP namespace 的形式表示，调用时使用当前环境实际暴露的工具。
先查看当前工具 schema；不猜字段，也不把读取结果原样传给写入工具。

## 修复前保留证据

用 `get_node({ nodeId })` 保留小范围的完整原始字段、绑定、样式、文字 runs、实例属性和父级 ID，
用 `get_screenshot({ nodeIds: [rootId] })` 保存该模块的原呈现。必要祖先用 `get_nodes_info({ nodeIds })` 精读，
但其返回的子树也可能很大，优先读取最小责任容器。
记录“规则 → 节点 → 旧值／绑定 → 新值／绑定 → 依据”，方便复查或在有回退需求时恢复。

`design_diff` 是可选的本地设计差异记录：初次调用会在 server 工作目录的 `.figwright/snapshots/` 创建基线，
已有基线可能属于代码同步，不要用 `update: true` 覆盖它来当本次修复前快照。
需要时使用明确的 rootDir 和目标 nodeId；只在变更验证后、该基线确实属于本次任务时接受新基线。
它不是撤销机制，也不是完整实例／Motion 验证。没有合适基线就直接比较本次保留的前后属性与截图。

## 工具与最小变更

| 问题／目标                     | 工具                                            | 必须保留的维度                                                                                              |
| ------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 已有布局的 padding、gap、对齐  | `set_auto_layout`                               | layoutMode 必填，沿用原模式；HORIZONTAL／VERTICAL 的 wrap 和 counterAxisSpacing、GRID 的行列 gap 分开处理。 |
| 内容撑高、填满、上下限、误裁剪 | `set_layout_props`                              | HUG 要求 Auto Layout frame 或 text，FILL 要求 Auto Layout 父级；min/max 仅适用于工具支持对象，null 才清除。 |
| 固定尺寸／画布放置             | `resize_nodes`、`set_position`                  | 仅调整真正需要固定尺寸／坐标的对象；不覆盖内容驱动尺寸、相对约束或绝对装饰层。                              |
| 字号／行高／文字溢出           | `set_text_properties`、`set_text_range`         | 混合 runs 用准确范围，保留链接、列表、粗细与不同颜色；先确认字体可用。                                      |
| 恢复已有共享样式               | `apply_style_to_node`                           | field 为 fill／stroke／effect／grid／text；整段 text style 会影响多项属性，确认适用于全节点。               |
| 绑定尺寸／间距／圆角等标量     | `bind_variable_to_node`                         | field 使用可绑定的原始字段名，如 itemSpacing／paddingLeft；变量 resolvedType 匹配。                         |
| 绑定填充／描边颜色             | `bind_variable_to_paint`                        | 使用 target=fills／strokes 和准确 index；颜色绑定在 paint 上，不是 node 上。                                |
| 公开实例属性／变体             | `set_instance_properties`                       | 先 `get_component_api` 获取实际属性名与选项；保留来源及其它实例覆盖。                                       |
| 确定的圆角／描边／paint 偏差   | `set_corner_radius`、`set_strokes`、`set_fills` | 保留逐角 radius、cornerSmoothing、逐边描边、strokeAlign、paint 顺序／透明度／模式和绑定。                   |

只传改变的字段。切换模式、把 GRID 变成 flex、把布局都改成绝对坐标或对整页重建，通常不是最小修复。
只有已确认布局结构本身是根因且任务包含该修改时才转换布局；先在代表模块验证。
现有 wrap 需区分主轴 itemSpacing 与跨轴 counterAxisSpacing；SPACE_BETWEEN 的实际间距不能靠改 gap 单独保证。

### 复用与绑定

读取已有变量／样式及组件公开能力，按职责选正确对象。`projectTokens` 的值匹配、token_map 的模糊候选
或一个同色 hex 不足以证明应该 rebind；没有语义证据时保留原值并报告缺口。

需要更换 paint 且有明确绑定时，保留其它 paint，先设所需值，再用 `bind_variable_to_paint` 绑定；
其它标量用 `bind_variable_to_node`，多属性共享外观用 `apply_style_to_node`。
每次重新设值／样式后检查原绑定是否仍在，不以当前渲染颜色相同代替绑定验证。

`get_variable_defs` / `get_styles` 主要列出目标文件的本地定义，空列表不能证明不存在库 token。
库项需要已有 key 或在已连接库文件读取；返回目标文件后用 `import_variable({ variableKey })` /
`import_style({ styleKey })` 导入，使用返回的目标文件 variableId／styleId，而非 key 或库文件 ID。
导入放在 batch 之前；导入无法精确回滚。没有库访问时报告依赖，继续其它独立修复。

优先改实例的公开属性或外层布局；需要内部覆盖时遵循项目保护规则、保留实例来源并检查其它覆盖。
不通过 `detach_instance` 或重建为 primitives 修复一致性。更改 main component、共享 style 或 variable value
需要任务明确覆盖其使用范围，否则给出库级修复建议。

## 小批次与失败处理

使用 `batch({ ops: [{ tool, params }] })` 聚合同一根因、可精确逆转且目标稳定的写入。
ops 按顺序执行；独立创建后才得到的节点 ID 不应提前猜填到后续 ops。
delete_*、detach_instance、ungroup_nodes、库导入与 `configure_responsive_layout` 持久配置不能作为普通可回滚修复。
批处理失败会尝试回滚；以错误内容及回读确认实际恢复范围，不能保证所有失败都已恢复。

一次性优化不新建或重配持久响应控制器；当前工具提供 `get_responsive_layout` 时，用它读取已有规则。
已有控制器管理的节点需先了解其规则，
否则手工修改可能在下一次 apply／重新打开时被覆盖。需要改规则时按任务授权单独处理，不能放入 batch。

出现超时、断连、pluginSkewNotice 或回滚失败：暂停相关写入，重新确认文件／节点及实际状态。
不盲重放创建或结构变更；精确恢复也要确认旧字段仍对应本次修改，避免覆盖用户的并发编辑。

## 一个小范围例子

假设已读到表单操作组是 `HORIZONTAL`、gap 为 6，规范要求 `spacing/action` 变量，
`get_variable_defs` 已确认它是 FLOAT、目标模式值为 16。节点与变量 ID 从实际结果取得。

```json
{
  "ops": [
    {
      "tool": "bind_variable_to_node",
      "params": {
        "nodeId": "12:34",
        "field": "itemSpacing",
        "variableId": "VariableID:5:12"
      }
    }
  ]
}
```

这是 batch 参数形状示例，不能直接用示例 ID 操作真实稿。
单个修改也可直接调用该写工具；不需要为了一个字段强制用 batch。

## 验证责任范围

1. 回读修改节点，确认值、变量／样式绑定及实例来源满足原规则。
2. 回读承担布局的祖先及受影响兄弟／实例，确认换行、HUG/FILL、边界和其它布局维度没有回退。
3. 重新截图，对比同尺寸、模式、内容与状态下的呈现；`empty: true` 表示没有有效呈现证据。
4. 检查本次范围内受影响的主题、长文案及必要状态；不自动增加手机稿、暗色稿或新业务页面。
5. 写明已验证与剩余项；只有当前证据证明原问题消失且相关维度未回退，才标记已修复。

文字仍裁切时读全祖先链找固定高度／maxHeight／mask；对比度仍不足时找有效模式与背景合成；
写值不生效时查变量绑定、组件覆盖或控制器。根因检查优先于继续叠加补丁。
