import { type RequestHandler, Router } from 'express';
import { calcOpenAIToken } from '../model/openai.js';
import { z } from 'zod';
import OpenAI from 'openai';
import { prisma } from '../model/_client.js';
import { AIGatewayLogs, AIGatewayLogsStatus } from '@prisma/client';
import { getLLMCostDecimal } from '../utils/llm.js';

export const aiGatewayRouter = Router();

const openaiRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(z.any()).nonempty(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_tokens: z.number().int().optional(),
    stream: z.boolean().optional(),
    presence_penalty: z.number().optional(),
    frequency_penalty: z.number().optional(),
  })
  .passthrough();

aiGatewayRouter.post(
  '/v1/:workspaceId/:gatewayId/openai/chat/completions',
  buildOpenAIHandler({})
);

aiGatewayRouter.post(
  '/v1/:workspaceId/:gatewayId/deepseek/chat/completions',
  buildOpenAIHandler({
    baseUrl: 'https://api.deepseek.com',
  })
);

aiGatewayRouter.post(
  '/v1/:workspaceId/:gatewayId/openrouter/chat/completions',
  buildOpenAIHandler({
    baseUrl: 'https://openrouter.ai/api/v1',
  })
);

interface OpenaiHandlerOptions {
  baseUrl?: string;
}

export function buildOpenAIHandler(
  options: OpenaiHandlerOptions
): RequestHandler {
  return async (req, res) => {
    const payload = openaiRequestSchema.parse(req.body);
    const { model, messages, stream } = payload;
    const { workspaceId, gatewayId } = z
      .object({
        workspaceId: z.string(),
        gatewayId: z.string(),
      })
      .parse(req.params);
    const apiKey = (req.headers.authorization ?? '').replace('Bearer ', '');
    const start = Date.now();

    const logP = new Promise<AIGatewayLogs>(async (resolve) => {
      const inputToken = messages.reduce((acc, msg) => {
        return acc + calcOpenAIToken(String(msg.content), model);
      }, 0);

      const _log = await prisma.aIGatewayLogs.create({
        data: {
          workspaceId,
          gatewayId,
          modelName: model,
          stream,
          inputToken,
          outputToken: -1,
          duration: -1,
          ttft: -1,
          requestPayload: payload,
          responsePayload: {},
          status: AIGatewayLogsStatus.Pending,
        },
      });

      resolve(_log);
    });

    try {
      const openai = new OpenAI({
        apiKey,
        baseURL: options.baseUrl,
      });

      // Handle stream response
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const stream = await openai.chat.completions.create({
          ...payload,
          stream: true,
        });

        let outputContent = '';
        let ttft = -1;
        let modelName = model; // real model name which returned from remote. its will be some changed because of the model alias.
        for await (const chunk of stream) {
          modelName = chunk.model;
          if (ttft === -1) {
            ttft = Date.now() - start;
          }
          const content = chunk.choices[0]?.delta?.content || '';
          outputContent += content;
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);

          if (res.flush) {
            res.flush();
          }
        }

        res.write('data: [DONE]\n\n');
        res.end();
        const duration = Date.now() - start;

        logP.then(async ({ id: logId, inputToken }) => {
          const outputToken = calcOpenAIToken(outputContent, model);

          await prisma.aIGatewayLogs.update({
            where: {
              id: logId,
            },
            data: {
              status: AIGatewayLogsStatus.Success,
              modelName,
              outputToken,
              duration,
              ttft,
              price: getLLMCostDecimal(modelName, inputToken, outputToken),
              responsePayload: { content: outputContent },
            },
          });
        });
      } else {
        // Handle normal response
        const response = await openai.chat.completions.create({
          ...payload,
          stream: false,
        });

        const modelName = response.model ?? model;

        res.json(response);
        const duration = Date.now() - start;

        logP.then(async ({ id: logId, inputToken }) => {
          const outputToken =
            response.usage?.completion_tokens ??
            (typeof response.choices[0].message.content === 'string'
              ? calcOpenAIToken(response.choices[0].message.content, model)
              : 0);

          await prisma.aIGatewayLogs.update({
            where: {
              id: logId,
            },
            data: {
              status: AIGatewayLogsStatus.Success,
              outputToken,
              duration,
              price: getLLMCostDecimal(modelName, inputToken, outputToken),
              responsePayload: { ...response },
            },
          });
        });
      }
    } catch (error) {
      // Handle API error
      console.error('OpenAI API error:', error);
      res.status(500).json({
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          type: 'server_error',
        },
      });

      const duration = Date.now() - start;
      logP.then(async ({ id: logId }) => {
        await prisma.aIGatewayLogs.update({
          where: {
            id: logId,
          },
          data: {
            status: AIGatewayLogsStatus.Failed,
            duration,
            responsePayload: {
              error: String(error),
            },
          },
        });
      });
    }
  };
}
