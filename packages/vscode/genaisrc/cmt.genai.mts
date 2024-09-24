script({
    title: "Source Code Comment Generator",
    description: `Add comments to source code to make it more understandable for AI systems or human developers.
    Modified from https://x.com/mckaywrigley/status/1838321570969981308.
    `,
    parameters: {
        format: {
            type: "string",
            description: "Format source code command",
        },
        build: {
            type: "string",
            description: "Build command",
        },
    },
})

const { format, build } = env.vars

// Get files from environment or modified files from Git if none provided
let files = env.files
if (files.length === 0) {
    // If no files are provided, read all modified files
    files = await Promise.all(
        (await host.exec("git status --porcelain")).stdout
            .split("\n")
            .filter((filename) => /^ [M|U]/.test(filename))
            .map(
                async (filename) =>
                    await workspace.readText(filename.replace(/^ [M|U] /, ""))
            )
    )
}

// custom filter to only process code files
files = files.filter(
    ({ filename }) =>
        /\.(ts|cs|py|js|java)$/.test(filename) && // known languages only
        !/\.test/.test(filename) // ignore test files
)

// Shuffle files
files = files.sort(() => Math.random() - 0.5)

// Process each file separately to avoid context explosion
await Promise.all(files.map((file) => processFile(file)))

async function processFile(file: WorkspaceFile) {
    console.log(`processing ${file.filename}`)
    try {
        const newContent = await addComments(file)
        // Save modified content if different
        if (newContent && file.content !== newContent) {
            console.log(`updating ${file.filename}`)
            await workspace.writeText(file.filename, newContent)
            let revert = false
            // try formatting
            if (format) {
                const formatRes = await host.exec(`${format} ${file.filename}`)
                if (formatRes.exitCode !== 0) {
                    revert = true
                }
            }
            // try building
            if (!revert && build) {
                const buildRes = await host.exec(`${build} ${file.filename}`)
                if (buildRes.exitCode !== 0) {
                    revert = true
                }
            }
            // last LLM as judge check
            if (!revert) revert = await checkModifications(file.filename)

            // revert
            if (revert) {
                console.error(`reverting ${file.filename}...`)
                await workspace.writeText(file.filename, file.content)
            }
        }
    } catch (e) {
        console.error(`error: ${e}`)
    }
}

// Function to add comments to code
async function addComments(file: WorkspaceFile): Promise<string | undefined> {
    let { filename, content } = file
    if (parsers.tokens(file) > 20000) return undefined // too big

    // run twice as genai tend to be lazy
    for (let i = 0; i < 2; i++) {
        const res = await runPrompt(
            (ctx) => {
                // Define code snippet for AI context with line numbers
                const code = ctx.def(
                    "CODE",
                    { filename, content },
                    { lineNumbers: true }
                )

                // AI prompt to add comments for better understanding
                ctx.$`You are an expert developer at all programming languages.

You are tasked with adding comments to code in ${code} to make it more understandable for AI systems or human developers.
You should analyze it, and add/update appropriate comments as needed.

To add or update comments to this code, follow these steps:

1. Analyze the code to understand its structure and functionality.
- If you are not familiar with the programming language, emit an empty file.
- If there is no code, emit an empty file.
2. Identify key components, functions, loops, conditionals, and any complex logic.
3. Add comments that explain:
- The purpose of functions or code blocks using the best comment format for that programming language.
- How complex algorithms or logic work
- Any assumptions or limitations in the code
- The meaning of important variables or data structures
- Any potential edge cases or error handling
- All function arguments and return value
- Top level file comment that description, tags

When adding or updating comments, follow these guidelines:

- Use clear and concise language
- Avoid stating the obvious (e.g., don't just restate what the code does)
- Focus on the "why" and "how" rather than just the "what"
- Use single-line comments for brief explanations
- Use multi-line comments for longer explanations or function/class descriptions
- Always place comments above the code they refer to. 
- If comments already exist, review and update them as needed.
- Minimize changes to existing comments.
- For TypeScript functions, classes and fields, use JSDoc comments. do NOT add type annotations in comments.
- For Python functions and classes, use docstrings.
- do not modify comments with TODOs.
- do not modify comments with URLs or links as they are reference to external resources.

Your output should be the original code with your added comments. Make sure to preserve the original code's formatting and structure. 

Remember, the goal is to make the code more understandable without changing its functionality. DO NOT MODIFY THE CODE ITSELF.
Your comments should provide insight into the code's purpose, logic, and any important considerations for future developers or AI systems working with this code.
`
            },
            { system: ["system", "system.files"], cache: "cmt-gen", label: `comment ${filename}` }
        )
        const { text, fences } = res
        const newContent = fences?.[0]?.content ?? text
        if (!newContent?.trim()) return undefined
        if (newContent === content) break
        content = newContent
    }
    return content
}

async function checkModifications(filename: string): Promise<boolean> {
    const diff = await host.exec(`git diff ${filename}`)
    if (!diff.stdout) return false
    const res = await runPrompt(
        (ctx) => {
            ctx.def("DIFF", diff.stdout)
            ctx.$`You are an expert developer at all programming languages.
        
        Your task is to analyze the changes in DIFF and make sure that only comments are modified. 
        Report all changes that are not comments and print "MODIFIED".
        `
        },
        {
            cache: "cmt-check",
            label: `check comments in ${filename}`,
        }
    )

    const modified = res.text?.includes("MODIFIED")
    console.log(`code modified, reverting...`)
    return modified
}
