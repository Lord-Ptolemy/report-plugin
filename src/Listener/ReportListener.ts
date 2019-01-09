import {AxiosInstance} from 'axios';
import {Client, Guild, Member, Message, TextChannel} from 'eris';
import {types as CFTypes} from 'eris-command-framework';
import Embed from 'eris-command-framework/Model/Embed';
import {Express} from 'express';
import {inject, injectable} from 'inversify';
import * as moment from 'moment';
import {Connection, Repository} from 'typeorm';
import {Logger} from 'winston';

import ReportMessage from '../Entity/ReportMessage';
import Subscription from '../Entity/Subscription';
import ReportPlugin from '../index';
import * as interfaces from '../interfaces';
import Types from '../types';

@injectable()
export default class ReportListener {
    private reportMessageRepo: Repository<ReportMessage>;

    private subscriptionRepo: Repository<Subscription>;

    private guild: Guild;

    public constructor(
        @inject(Types.webserver) private webserver: Express,
        @inject(CFTypes.logger) private logger: Logger,
        @inject(CFTypes.connection) private database: Connection,
        @inject(CFTypes.discordClient) private client: Client,
        @inject(Types.api.client) private api: AxiosInstance,
    ) {
        this.reportMessageRepo = this.database.getRepository<ReportMessage>(ReportMessage);
        this.subscriptionRepo  = this.database.getRepository<Subscription>(Subscription);

        this.client.off('guildMemberAdd', this.onGuildMemberAdd.bind(this));
        this.client.on('guildMemberAdd', this.onGuildMemberAdd.bind(this));
    }

    public async initialize() {
        this.guild = this.client.guilds.get(ReportPlugin.Config.hotlineGuildId);
        if (!this.guild) {
            return this.logger.error(
                'Failed to initialize WebhookListener. Guild could not be found with the id: %s',
                ReportPlugin.Config.hotlineGuildId,
            );
        }

        this.webserver.post('/subscription/global', async (req, res) => {
            const subscriptions             = await this.subscriptionRepo.find();
            const report: interfaces.Report = JSON.parse(req.body.report);

            const promises = subscriptions.map((subscription) => {
                const tags = subscription.tags.map((x) => parseInt('' + x, 10));
                for (const tag of report.tags) {
                    if (tags.includes(tag.id)) {
                        return this.sendReportToSubscription(req.body.action, report, subscription);
                    }
                }

                return Promise.resolve();
            });

            try {
                await Promise.all(promises);
                res.status(204).send();
            } catch (e) {
                res.status(500).json(e);
            }
        });
    }

    /**
     * Listen for new members on every guild (except hotline).
     *
     * Find reports on new members. If there are no reports, return early.
     * If there are reports, find all subscriptions for that guild, then make sure the reports match the subscriptions.
     *
     * Finally, take the matching subscriptions and edit them. This ensures that if there is already a message,
     * it wont post another one.
     */
    private async onGuildMemberAdd(guild: Guild, member: Member): Promise<void> {
        if (guild.id === '204100839806205953') {
            return;
        }

        const reportCall = await this.api.get<interfaces.ApiReportList>('/report?reported=' + member.id);
        if (reportCall.data.count === 0) {
            return;
        }

        const reports = reportCall.data.results;
        const subscriptions = await this.subscriptionRepo.find({guildId: guild.id});
        for (const subscription of subscriptions) {
            const tags = subscription.tags.map((x) => parseInt('' + x, 10));
            for (const report of reports) {
                for (const tag of report.tags) {
                    if (tags.includes(tag.id)) {
                        // Edit any existing messages, if there are any, otherwise, add a new one.
                        return this.sendReportToSubscription('edit', report, subscription);
                    }
                }
            }
        }
    }

    private async sendReportToSubscription(
        action: 'new' | 'edit' | 'delete',
        report: interfaces.Report,
        subscription: Subscription,
    ): Promise<void> {
        const guild = this.client.guilds.get(subscription.guildId);
        if (!guild) {
            this.logger.error('Subscription found for unavailable guild: %s', subscription.guildId);

            return;
        }

        const channel: TextChannel = guild.channels.get(subscription.channelId) as TextChannel;
        if (!channel) {
            this.logger.error(
                'Subscription found for unavailable channel. Guild: %s, Channel: %s',
                guild.id,
                subscription.channelId,
            );

            return;
        }

        let message: Message;
        let reportMessage: ReportMessage = await this.reportMessageRepo.findOne({
            reportId:  report.id,
            guildId:   subscription.guildId,
            channelId: subscription.channelId,
        });
        const embed                      = await this.createReportEmbed(report);

        /**
         * If we are editing an existing report, go through here.
         *
         * If there is no report message, just treat this as a new message
         */
        if (action === 'edit' && reportMessage) {
            message = await channel.getMessage(reportMessage.messageId);
            if (message) {
                await message.edit({embed: embed.serialize()});
                reportMessage.updateDate = new Date();
                await reportMessage.save();
            } else {
                message                 = await channel.createMessage({embed: embed.serialize()});
                reportMessage.messageId = message.id;
                await reportMessage.save();
            }

            return;
        }

        /**
         * If we are deleting an existing report, go through here.
         *
         * If there is no report message, just skip this whole process. Nothing to do.
         */
        if (action === 'delete') {
            if (!reportMessage) {
                return;
            }

            message               = await channel.getMessage(reportMessage.messageId);
            reportMessage.deleted = true;
            if (message) {
                await message.delete('Deleted Report');
                reportMessage.updateDate = new Date();
                await reportMessage.save();
            }

            return;
        }

        let hasUsers = false;
        if (subscription.onUsersInServer) {
            for (const user of report.reportedUsers) {
                if (guild.members.get(user.id)) {
                    hasUsers = true;
                }
            }
        }

        if (subscription.onUsersInServer && !hasUsers) {
            return;
        }

        /**
         * If we are creating a new report message, go through here
         *
         * Create a new reportMessage if there isn't one. This should usually happen here. Will only not happen if the
         * edit fires before a message is created
         */
        message = await channel.createMessage({embed: embed.serialize()});
        if (!reportMessage) {
            reportMessage            = new ReportMessage();
            reportMessage.reportId   = report.id;
            reportMessage.guildId    = this.guild.id;
            reportMessage.channelId  = channel.id;
            reportMessage.insertDate = new Date();
        }

        reportMessage.messageId  = message.id;
        reportMessage.updateDate = new Date();

        await reportMessage.save();

        return;
    }

    private async createReportEmbed(report: interfaces.Report): Promise<Embed> {
        const reportedUsers = report.reportedUsers.map((x) => `<@${x.id}> (${x.id})`);
        const links         = report.links.map((x) => `<${x}>`);
        const tags          = report.tags.map((x) => x.name);

        let description = `**Users:** \n${reportedUsers.join(', ')}`;
        if (report.reason) {
            description += `\n\n**Reason:** ${report.reason}`;
        }

        if (report.tags.length > 0) {
            description += `\n\n**Tags:** \n${tags.join(', ')}`;
        }

        if (report.links.length > 0) {
            description += `\n\n**Links:** \n${links.join('\\n')}`;
        }

        const created    = moment(report.insertDate).format('YYYY-MM-DD HH:mm');
        const footerText = `Confirmations: ${report.confirmationUsers.length} | Created: ${created}`;

        const embed = new Embed();

        embed.author      = {name: `Report ID: ${report.id}`};
        embed.description = description;
        embed.footer      = {text: footerText};
        embed.timestamp   = report.updateDate;

        return embed;
    }
}
