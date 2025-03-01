import { z } from 'zod';
import { router, workspaceProcedure } from '../trpc.js';
import {
  calcOpenAIToken,
  modelName,
  getOpenAIClient,
} from '../../model/openai.js';
import { env } from '../../utils/env.js';
import {
  classifySurveyInputSchema,
  getSurveyPrompt,
  translateSurveyInputSchema,
} from '../../model/prompt/survey.js';
// @ts-ignore
import type { ChatCompletionMessageParam } from 'openai/resources/index.mjs';
import { sum } from 'lodash-es';
import { createAuditLog } from '../../model/auditLog.js';
import {
  checkCredit,
  costCredit,
  tokenCreditFactor,
} from '../../model/billing/credit.js';
import {
  sendBuildSurveyClassifyMessageQueue,
  sendBuildSurveyTranslationMessageQueue,
} from '../../mq/producer.js';

export const aiRouter = router({
  ask: workspaceProcedure
    .input(
      z.object({
        question: z.string(),
        context: z
          .union([
            z.object({
              type: z.literal('survey'),
              surveyId: z.string(),
            }),
            z.object({
              type: z.literal('unknown'),
            }),
          ])
          .optional(),
      })
    )
    .query(async function* ({ input, ctx }) {
      const { workspaceId, question, context } = input;
      const userId = ctx.user.id;

      if (env.isProd) {
        return '';
      }

      if (!env.openai.enable) {
        return '';
      }

      await checkCredit(workspaceId);

      let promptMessages: ChatCompletionMessageParam[] = [];
      if (context?.type === 'survey') {
        promptMessages = await getSurveyPrompt(context.surveyId);
      }

      const messages: ChatCompletionMessageParam[] = [
        ...promptMessages,
        { role: 'user', content: question },
      ];

      const inputToken = sum(
        messages.map((m) => calcOpenAIToken(String(m.content)))
      );

      const stream = await getOpenAIClient().chat.completions.create({
        model: modelName,
        messages,
        stream: true,
      });
      let result = '';
      for await (const chunk of stream) {
        result += chunk.choices[0].delta.content ?? '';

        yield {
          finish_reason: chunk.choices[0].finish_reason,
          content: chunk.choices[0].delta.content ?? '',
        };
      }

      const outputToken = calcOpenAIToken(result);

      const credit = tokenCreditFactor * (inputToken + outputToken);

      costCredit(workspaceId, credit, 'ai', {
        inputToken,
        outputToken,
        context,
        userId,
      });
      createAuditLog({
        workspaceId,
        content: JSON.stringify({
          type: 'ai',
          context,
          credit,
          inputToken,
          outputToken,
        }),
      });
    }),
  classifySurvey: workspaceProcedure
    .input(classifySurveyInputSchema)
    .mutation(async ({ input, ctx }) => {
      const {
        workspaceId,
        surveyId,
        startAt,
        endAt,
        runStrategy,
        languageStrategy,
        payloadContentField,
        suggestionCategory,
      } = input;
      const { language } = ctx;

      await sendBuildSurveyClassifyMessageQueue({
        workspaceId,
        surveyId,
        startAt,
        endAt,
        runStrategy,
        languageStrategy,
        payloadContentField,
        suggestionCategory,
        language,
      });

      return 'ok';
    }),
  translateSurvey: workspaceProcedure
    .input(translateSurveyInputSchema)
    .mutation(async ({ input, ctx }) => {
      const {
        workspaceId,
        surveyId,
        startAt,
        endAt,
        runStrategy,
        languageStrategy,
        payloadContentField,
      } = input;
      const { language } = ctx;

      sendBuildSurveyTranslationMessageQueue({
        workspaceId,
        surveyId,
        startAt,
        endAt,
        runStrategy,
        languageStrategy,
        payloadContentField,
        language,
      });

      return 'ok';
    }),
});
