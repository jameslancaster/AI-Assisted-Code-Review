import tl = require('azure-pipelines-task-lib/task');
import { encode } from 'gpt-tokenizer';
import OpenAI from "openai";
import { IInlineComment } from './types';

export class ChatGPT {
    private readonly systemMessage: string = '';
    private readonly apiUrl: string;
    private readonly supportedModels: string[] = [
        'gpt-4o',
        'gpt-4o-mini',
        'gpt-4o-2024-11-20',
        'gpt-4o-2024-08-06',
        'gpt-4o-2024-05-13',
        'gpt-4o-mini-2024-07-18',
        'gpt-4-turbo',
        'gpt-4-turbo-2024-04-09',
        'gpt-4-1106-preview',
        'gpt-4',
        'gpt-4-0613',
        'gpt-3.5-turbo',
        'gpt-3.5-turbo-0125',
        'gpt-3.5-turbo-1106'
    ];

    constructor(
        private _openAi: OpenAI,
        checkForBugs: boolean = false,
        checkForPerformance: boolean = false,
        checkForBestPractices: boolean = false,
        additionalPrompts: string[] = [],
        apiUrl: string = 'https://api.openai.com/v1', // Default OpenAI API URL
        private maxTokens: number = 4096, // Default maximum tokens
        systemPromptOverride?: string
    ) {
        this.apiUrl = apiUrl;

        console.log(`ChatGPT initialized with API URL: ${apiUrl} and max tokens: ${maxTokens}`);

        if (systemPromptOverride) {
            this.systemMessage = systemPromptOverride;
        } else {
            this.systemMessage = `Your task is to act as a code reviewer of a Pull Request:
        - Use bullet points if you have multiple comments.
        ${checkForBugs ? '- If there are any bugs, highlight them.' : ''}
        ${checkForPerformance ? '- If there are major performance problems, highlight them.' : ''}
        ${checkForBestPractices ? '- Provide details on missed use of best-practices.' : ''}
        ${additionalPrompts.length > 0 ? additionalPrompts.map(str => `- ${str}`).join('\n') : ''}
        - Do not highlight minor issues and nitpicks.
        - Only provide instructions for improvements.

        You are provided with the code changes (diffs) in a unidiff format.

        Return your review as a JSON array. Each element must have:
          - "lineNumber": the line number in the new (right-side) version of the file where the issue occurs, or null if not line-specific
          - "comment": the review comment in markdown

        Example:
        [
          { "lineNumber": 42, "comment": "This could cause a null reference when \`user\` is null." }
        ]

        If you have no comments respond with an empty array: []`;
        }
    }

    public async PerformCodeReview(diff: string, fileName: string, fileContent?: string): Promise<IInlineComment[]> {
        let model = tl.getInput('ai_model', true) as string; // Allow any string as the model name

        // Validate the model
        if (!this.supportedModels.includes(model)) {
            tl.warning(`The specified model "${model}" is not officially supported. Proceeding with caution.`);
        }

        let userMessage = this.buildUserMessage(diff, fileContent);
        if (this.doesMessageExceedTokenLimit(this.systemMessage + userMessage, this.maxTokens)) {
            if (fileContent) {
                tl.warning(`Including full file content for ${fileName} would exceed token limit. Falling back to diff-only.`);
                userMessage = diff;
            }
            if (this.doesMessageExceedTokenLimit(this.systemMessage + userMessage, this.maxTokens)) {
                tl.warning(`The diff for file ${fileName} exceeds the token limit of ${this.maxTokens}. Skipping review.`);
                return [];
            }
        }

        try {
            console.log('Request payload:', {
                messages: [
                    { role: 'system', content: this.systemMessage },
                    { role: 'user', content: userMessage }
                ],
                model: model
            });

            console.log(`Using API URL: ${this.apiUrl}`);

            let openAi = await this._openAi.chat.completions.create({
                messages: [
                    { role: 'system', content: this.systemMessage },
                    { role: 'user', content: userMessage }
                ],
                model: model
            });

            let response = openAi.choices;

            if (response.length > 0) {
                const content = response[0].message.content;
                if (!content) return [];
                return this.parseReviewResponse(content, fileName);
            }
        } catch (error: any) {
            tl.error(`Error during API call: ${error.message}`);
            if (error.response) {
                console.error('API response:', error.response.data);
            }
            return [];
        }

        tl.warning(`Unable to process diff for file ${fileName} as it exceeds token limits.`);
        return [];
    }

    private buildUserMessage(diff: string, fileContent?: string): string {
        if (fileContent) {
            return `Full file content (for context):\n\`\`\`\n${fileContent}\n\`\`\`\n\nChanges to review (diff):\n${diff}`;
        }
        return diff;
    }

    private parseReviewResponse(text: string, fileName: string): IInlineComment[] {
        const trimmed = text.trim();
        if (!trimmed || trimmed.includes('NO_COMMENT')) {
            return [];
        }
        try {
            const jsonText = trimmed.replace(/^```(?:json)?\r?\n?/, '').replace(/\r?\n?```$/, '');
            const parsed = JSON.parse(jsonText);
            if (Array.isArray(parsed)) {
                return parsed as IInlineComment[];
            }
            if (parsed && typeof parsed === 'object') {
                return [parsed as IInlineComment];
            }
        } catch {
            tl.warning(`Could not parse JSON review response for ${fileName}. Falling back to file-level comment.`);
            return [{ lineNumber: null, comment: trimmed }];
        }
        return [{ lineNumber: null, comment: trimmed }];
    }

    private doesMessageExceedTokenLimit(message: string, tokenLimit: number): boolean {
        let tokens = encode(message);
        return tokens.length > tokenLimit;
    }
}
