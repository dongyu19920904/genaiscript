import { CSVToMarkdown, CSVTryParse } from "./csv"
import { resolveFileContent } from "./file"
import { addLineNumbers } from "./liner"
import { stringifySchemaToTypeScript } from "./schema"
import { estimateTokens } from "./tokens"
import { MarkdownTrace, TraceOptions } from "./trace"
import { assert, toStringList, trimNewlines } from "./util"
import { YAMLStringify } from "./yaml"
import { MARKDOWN_PROMPT_FENCE, PROMPT_FENCE } from "./constants"
import { fenceMD } from "./markdown"

export interface PromptNode extends ContextExpansionOptions {
    type?:
        | "text"
        | "image"
        | "schema"
        | "function"
        | "fileMerge"
        | "outputProcessor"
        | "stringTemplate"
        | "assistant"
        | "def"
        | undefined
    children?: PromptNode[]
    error?: unknown
    tokens?: number
}

export interface PromptTextNode extends PromptNode {
    type: "text"
    value: string | Promise<string>
    resolved?: string
}

export interface PromptDefNode extends PromptNode, DefOptions {
    type: "def"
    name: string
    value: LinkedFile | Promise<LinkedFile>
    resolved?: LinkedFile
}

export interface PromptAssistantNode extends PromptNode {
    type: "assistant"
    value: string | Promise<string>
    resolve?: string
}

export interface PromptStringTemplateNode extends PromptNode {
    type: "stringTemplate"
    strings: TemplateStringsArray
    args: any[]
    resolved?: string
}

export interface PromptImage {
    url: string
    filename?: string
    detail?: "low" | "high"
}

export interface PromptImageNode extends PromptNode {
    type: "image"
    value: PromptImage | Promise<PromptImage>
    resolved?: PromptImage
}

export interface PromptSchemaNode extends PromptNode {
    type: "schema"
    name: string
    value: JSONSchema
    options?: DefSchemaOptions
}

export interface PromptFunctionNode extends PromptNode {
    type: "function"
    name: string
    description: string
    parameters: ChatFunctionParameters
    fn: ChatFunctionHandler
}

export interface PromptFileMergeNode extends PromptNode {
    type: "fileMerge"
    fn: FileMergeHandler
}

export interface PromptOutputProcessorNode extends PromptNode {
    type: "outputProcessor"
    fn: PromptOutputProcessorHandler
}

export function createTextNode(
    value: string | Promise<string>,
    options?: ContextExpansionOptions
): PromptTextNode {
    assert(value !== undefined)
    return { type: "text", value, ...(options || {}) }
}

export function createDefNode(
    name: string,
    file: LinkedFile,
    options: DefOptions & TraceOptions
): PromptDefNode {
    name = name ?? ""
    const render = async () => {
        await resolveFileContent(file, options)
        return file
    }
    const value = render()
    return { type: "def", name, value, ...(options || {}) }
}

function renderDefNode(def: PromptDefNode): string {
    const { name, resolved } = def
    const file = resolved
    const { language, lineNumbers, schema } = def || {}
    const fence =
        language === "markdown" || language === "mdx"
            ? MARKDOWN_PROMPT_FENCE
            : PROMPT_FENCE
    const norm = (s: string, f: string) => {
        s = (s || "").replace(/\n*$/, "")
        if (s && lineNumbers) s = addLineNumbers(s)
        if (s) s += "\n"
        if (f && s.includes(f)) throw new Error("source contains fence")
        return s
    }

    let dfence =
        /\.mdx?$/i.test(file.filename) || file.content?.includes(fence)
            ? MARKDOWN_PROMPT_FENCE
            : fence
    const dtype = language || /\.([^\.]+)$/i.exec(file.filename)?.[1] || ""
    let body = file.content
    if (/^(c|t)sv$/i.test(dtype)) {
        const parsed = CSVTryParse(file.content)
        if (parsed) {
            body = CSVToMarkdown(parsed)
            dfence = ""
        }
    }
    body = norm(body, dfence)
    const res =
        (name ? name + ":\n" : "") +
        dfence +
        dtype +
        (file.filename ? ` file="${file.filename}"` : "") +
        (schema ? ` schema=${schema}` : "") +
        "\n" +
        body +
        dfence +
        "\n"

    return res
}

export function createAssistantNode(
    value: string | Promise<string>,
    options?: ContextExpansionOptions
): PromptAssistantNode {
    assert(value !== undefined)
    return { type: "assistant", value, ...(options || {}) }
}

export function createStringTemplateNode(
    strings: TemplateStringsArray,
    args: any[],
    options?: ContextExpansionOptions
): PromptStringTemplateNode {
    assert(strings !== undefined)
    return { type: "stringTemplate", strings, args, ...(options || {}) }
}

export function createImageNode(
    value: PromptImage | Promise<PromptImage>,
    options?: ContextExpansionOptions
): PromptImageNode {
    assert(value !== undefined)
    return { type: "image", value, ...(options || {}) }
}

export function createSchemaNode(
    name: string,
    value: JSONSchema,
    options?: DefSchemaOptions
): PromptSchemaNode {
    assert(!!name)
    assert(value !== undefined)
    return { type: "schema", name, value, options }
}

export function createFunctionNode(
    name: string,
    description: string,
    parameters: ChatFunctionParameters,
    fn: ChatFunctionHandler
): PromptFunctionNode {
    assert(!!name)
    assert(!!description)
    assert(parameters !== undefined)
    assert(fn !== undefined)
    return { type: "function", name, description, parameters, fn }
}

export function createFileMergeNode(fn: FileMergeHandler): PromptFileMergeNode {
    assert(fn !== undefined)
    return { type: "fileMerge", fn }
}

export function createOutputProcessor(
    fn: PromptOutputProcessorHandler
): PromptOutputProcessorNode {
    assert(fn !== undefined)
    return { type: "outputProcessor", fn }
}

export function createDefDataNode(
    name: string,
    data: object | object[],
    options?: DefDataOptions
) {
    if (data === undefined) return undefined
    if (options?.maxTokens)
        throw new Error("maxTokens not supported for defData")

    let { format, headers, priority, maxTokens } = options || {}
    if (!format && headers && Array.isArray(data)) format = "csv"
    else if (!format) format = "yaml"

    let text: string
    let lang: string
    if (Array.isArray(data) && format === "csv") {
        text = CSVToMarkdown(data, { headers })
    } else if (format === "json") {
        text = JSON.stringify(data)
        lang = "json"
    } else {
        text = YAMLStringify(data)
        lang = "yaml"
    }

    const value = `${name}:
    ${lang ? fenceMD(text, lang) : text}`
    // TODO maxTokens does not work well with data
    return createTextNode(value, { priority, maxTokens })
}

export function appendChild(parent: PromptNode, child: PromptNode): void {
    if (!parent.children) {
        parent.children = []
    }
    parent.children.push(child)
}

export interface PromptNodeVisitor {
    node?: (node: PromptNode) => void | Promise<void>
    afterNode?: (node: PromptNode) => void | Promise<void>
    text?: (node: PromptTextNode) => void | Promise<void>
    def?: (node: PromptDefNode) => void | Promise<void>
    image?: (node: PromptImageNode) => void | Promise<void>
    schema?: (node: PromptSchemaNode) => void | Promise<void>
    function?: (node: PromptFunctionNode) => void | Promise<void>
    fileMerge?: (node: PromptFileMergeNode) => void | Promise<void>
    stringTemplate?: (node: PromptStringTemplateNode) => void | Promise<void>
    outputProcessor?: (node: PromptOutputProcessorNode) => void | Promise<void>
    assistant?: (node: PromptAssistantNode) => void | Promise<void>
}

export async function visitNode(node: PromptNode, visitor: PromptNodeVisitor) {
    await visitor.node?.(node)
    switch (node.type) {
        case "text":
            await visitor.text?.(node as PromptTextNode)
            break
        case "def":
            await visitor.def?.(node as PromptDefNode)
            break
        case "image":
            await visitor.image?.(node as PromptImageNode)
            break
        case "schema":
            await visitor.schema?.(node as PromptSchemaNode)
            break
        case "function":
            await visitor.function?.(node as PromptFunctionNode)
            break
        case "fileMerge":
            await visitor.fileMerge?.(node as PromptFileMergeNode)
            break
        case "outputProcessor":
            await visitor.outputProcessor?.(node as PromptOutputProcessorNode)
            break
        case "stringTemplate":
            await visitor.stringTemplate?.(node as PromptStringTemplateNode)
            break
        case "assistant":
            await visitor.assistant?.(node as PromptAssistantNode)
            break
    }
    if (node.children) {
        for (const child of node.children) {
            await visitNode(child, visitor)
        }
    }
    await visitor.afterNode?.(node)
}

export interface PromptNodeRender {
    prompt: string
    assistantPrompt: string
    images: PromptImage[]
    errors: unknown[]
    schemas: Record<string, JSONSchema>
    functions: ChatFunctionCallback[]
    fileMerges: FileMergeHandler[]
    outputProcessors: PromptOutputProcessorHandler[]
}

async function resolvePromptNode(
    model: string,
    node: PromptNode,
    options?: TraceOptions
): Promise<void> {
    await visitNode(node, {
        text: async (n) => {
            try {
                const value = await n.value
                n.resolved = value
                n.tokens = estimateTokens(model, value)
            } catch (e) {
                node.error = e
            }
        },
        def: async (n) => {
            try {
                const value = await n.value
                n.resolved = value
                const rendered = renderDefNode(n)
                n.tokens = estimateTokens(model, rendered)
            } catch (e) {
                node.error = e
            }
        },
        assistant: async (n) => {
            try {
                const value = await n.value
                n.resolve = value
                n.tokens = estimateTokens(model, value)
            } catch (e) {
                node.error = e
            }
        },
        stringTemplate: async (n) => {
            const { strings, args } = n
            try {
                let value = ""
                for (let i = 0; i < strings.length; ++i) {
                    value += strings[i]
                    if (i < args.length) {
                        const arg = await args[i]
                        value += arg ?? ""
                    }
                }
                n.resolved = value
                n.tokens = estimateTokens(model, value)
            } catch (e) {
                node.error = e
            }
        },
        image: async (n) => {
            try {
                const v = await n.value
                n.resolved = v
            } catch (e) {
                node.error = e
            }
        },
    })
}

async function truncatePromptNode(
    model: string,
    node: PromptNode,
    options?: TraceOptions
): Promise<boolean> {
    const { trace } = options || {}
    let truncated = false

    const cap = (n: {
        error?: unknown
        resolved?: string
        tokens?: number
        maxTokens?: number
    }) => {
        if (
            !n.error &&
            n.resolved !== undefined &&
            n.maxTokens !== undefined &&
            n.tokens > n.maxTokens
        ) {
            const value = n.resolved.slice(
                0,
                Math.floor((n.maxTokens * n.resolved.length) / n.tokens)
            )
            n.resolved = value
            n.tokens = estimateTokens(model, value)
            truncated = true
        }
    }

    const capDef = (n: PromptDefNode) => {
        if (
            !n.error &&
            n.resolved !== undefined &&
            n.maxTokens !== undefined &&
            n.tokens > n.maxTokens
        ) {
            n.resolved.content = n.resolved.content.slice(
                0,
                Math.floor((n.maxTokens * n.resolved.content.length) / n.tokens)
            )
            n.tokens = estimateTokens(model, n.resolved.content)
            truncated = true
        }
    }

    await visitNode(node, {
        text: cap,
        assistant: cap,
        stringTemplate: cap,
        def: capDef,
    })

    return truncated
}

export async function tracePromptNode(
    trace: MarkdownTrace,
    node: PromptNode,
    options?: { label: string }
) {
    if (!trace) return

    await visitNode(node, {
        node: (n) => {
            const title = toStringList(
                n.type || `🌳 prompt tree ${options?.label || ""}`,
                n.priority ? `#${n.priority}` : undefined,
                n.tokens
                    ? `${n.tokens}${n.maxTokens ? `/${n.maxTokens}` : ""}t`
                    : undefined
            )
            if (n.children?.length) trace.startDetails(title)
            else trace.item(title)
        },
        afterNode: (n) => {
            if (n.children?.length) trace.endDetails()
        },
    })
}

export async function renderPromptNode(
    model: string,
    node: PromptNode,
    options?: TraceOptions
): Promise<PromptNodeRender> {
    const { trace } = options || {}

    await resolvePromptNode(model, node, options)
    await tracePromptNode(trace, node)

    const truncated = await truncatePromptNode(model, node, options)
    if (truncated) await tracePromptNode(trace, node, { label: "truncated" })

    let prompt = ""
    let assistantPrompt = ""
    const images: PromptImage[] = []
    const errors: unknown[] = []
    const schemas: Record<string, JSONSchema> = {}
    const functions: ChatFunctionCallback[] = []
    const fileMerges: FileMergeHandler[] = []
    const outputProcessors: PromptOutputProcessorHandler[] = []

    await visitNode(node, {
        text: async (n) => {
            if (n.error) errors.push(n.error)
            const value = n.resolved
            if (value != undefined) prompt += value + "\n"
        },
        def: async (n) => {
            if (n.error) errors.push(n.error)
            const value = n.resolved
            if (value !== undefined) prompt += renderDefNode(n) + "\n"
        },
        assistant: async (n) => {
            if (n.error) errors.push(n.error)
            const value = await n.resolve
            if (value != undefined) assistantPrompt += value + "\n"
        },
        stringTemplate: async (n) => {
            if (n.error) errors.push(n.error)
            const value = n.resolved
            if (value != undefined) prompt += value + "\n"
        },
        image: async (n) => {
            if (n.error) errors.push(n.error)
            const value = n.resolved
            if (value?.url) {
                images.push(value)
                if (trace) {
                    trace.startDetails(
                        `📷 image: ${value.detail || ""} ${value.filename || value.url.slice(0, 64) + "..."}`
                    )
                    trace.image(value.url, value.filename)
                    trace.endDetails()
                }
            }
        },
        schema: (n) => {
            const { name: schemaName, value: schema, options } = n
            if (schemas[schemaName])
                trace.error("duplicate schema name: " + schemaName)
            schemas[schemaName] = schema
            const { format = "typescript" } = options || {}
            let schemaText: string
            switch (format) {
                case "json":
                    schemaText = JSON.stringify(schema, null, 2)
                    break
                case "yaml":
                    schemaText = YAMLStringify(schema)
                    break
                default:
                    schemaText = stringifySchemaToTypeScript(schema, {
                        typeName: schemaName,
                    })
                    break
            }
            const text = `${schemaName}:
\`\`\`${format + "-schema"}
${trimNewlines(schemaText)}
\`\`\`
`
            prompt += text
            n.tokens = estimateTokens(model, text)
            if (trace && format !== "json")
                trace.detailsFenced(
                    `🧬 schema ${schemaName} as ${format}`,
                    schemaText,
                    format
                )
        },
        function: (n) => {
            const { name, description, parameters, fn } = n
            functions.push({
                definition: { name, description, parameters },
                fn,
            })
            trace.detailsFenced(
                `🛠️ function ${name}`,
                { description, parameters },
                "yaml"
            )
        },
        fileMerge: (n) => {
            fileMerges.push(n.fn)
            trace.itemValue(`file merge`, n.fn)
        },
        outputProcessor: (n) => {
            outputProcessors.push(n.fn)
            trace.itemValue(`output processor`, n.fn)
        },
    })
    return {
        prompt,
        assistantPrompt,
        images,
        errors,
        schemas,
        functions,
        fileMerges,
        outputProcessors,
    }
}
