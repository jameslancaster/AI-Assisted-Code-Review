import tl = require('azure-pipelines-task-lib/task');
import Anthropic from '@anthropic-ai/sdk';
import { IInlineComment } from './types';

export class AnthropicReviewer {
    private readonly systemMessage: string;
    private readonly supportedModels: string[] = [
        'claude-opus-4-6',
        'claude-sonnet-4-6',
        'claude-haiku-4-5-20251001',
        'claude-3-5-sonnet-latest',
        'claude-3-5-haiku-latest',
        'claude-3-opus-latest',
    ];

    constructor(
        private _client: Anthropic,
        checkForBugs: boolean = false,
        checkForPerformance: boolean = false,
        checkForBestPractices: boolean = false,
        additionalPrompts: string[] = [],
        private maxTokens: number = 4096,
        systemPromptOverride?: string
    ) {
        console.log(`AnthropicReviewer initialized with max tokens: ${maxTokens}`);

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
        let model = tl.getInput('ai_model', true) as string;

        if (!this.supportedModels.includes(model)) {
            tl.warning(`The specified model "${model}" is not in the known Anthropic models list. Proceeding with caution.`);
        }

        let userMessage = this.buildUserMessage(diff, fileContent);
        if (this.estimateTokens(userMessage + this.systemMessage) > this.maxTokens) {
            if (fileContent) {
                tl.warning(`Including full file content for ${fileName} would exceed token limit. Falling back to diff-only.`);
                userMessage = diff;
            }
            if (this.estimateTokens(userMessage + this.systemMessage) > this.maxTokens) {
                tl.warning(`The diff for file ${fileName} likely exceeds the token limit of ${this.maxTokens}. Skipping review.`);
                return [];
            }
        }

        try {
            console.log('Request payload:', {
                system: this.systemMessage,
                messages: [{ role: 'user', content: userMessage }],
                model: model,
                max_tokens: this.maxTokens
            });

            const response = await this._client.messages.create({
                model: model,
                max_tokens: this.maxTokens,
                system: this.systemMessage,
                messages: [{ role: 'user', content: userMessage }]
            });

            if (response.content.length > 0 && response.content[0].type === 'text') {
                return this.parseReviewResponse(response.content[0].text, fileName);
            }
        } catch (error: any) {
            tl.error(`Error during Anthropic API call: ${error.message}`);
            if (error.response) {
                console.error('API response:', error.response);
            }
            return [];
        }

        tl.warning(`No text content returned from Anthropic API for file ${fileName}.`);
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
            // Strip markdown code fences if the model wrapped the JSON
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

    // Character-based token estimate (Anthropic uses its own tokenizer; ~3.5 chars/token is a safe upper bound)
    private estimateTokens(text: string): number {
        return Math.ceil(text.length / 3.5);
    }
}
