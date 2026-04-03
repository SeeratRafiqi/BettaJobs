import { DataTypes, Model } from 'sequelize';
import sequelize from '../config.js';
import { BaseModel } from '../base/BaseModel.js';

export type MatchStatus = 'pending' | 'shortlisted' | 'rejected';

export interface MatchAttributes {
  id: string;
  candidate_id: string;
  job_id: string;
  score: number; // 0-100
  breakdown: any; // JSON: skills/experience/domain/location scores
  explanation: string;
  gaps: any; // JSON
  status: MatchStatus;
  application_id?: string;
  calculated_at?: Date;
}

export class Match extends BaseModel<MatchAttributes> implements MatchAttributes {
  declare id: string;
  declare candidate_id: string;
  declare job_id: string;
  declare score: number;
  declare breakdown: any;
  declare explanation: string;
  declare gaps: any;
  declare status: MatchStatus;
  declare application_id?: string;
  declare calculated_at: Date;
}

Match.init(
  {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    candidate_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      references: {
        model: 'candidates',
        key: 'id',
      },
    },
    job_id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      references: {
        model: 'jobs',
        key: 'id',
      },
    },
    score: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        min: 0,
        max: 100,
      },
    },
    breakdown: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    explanation: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    gaps: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('pending', 'shortlisted', 'rejected'),
      allowNull: false,
      defaultValue: 'pending',
    },
    // No DB references here: circular FK with Application.match_id → matches.
    // Sync order: matches before applications would break; link enforced in app / associations.
    application_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
    },
    calculated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'matches',
    timestamps: false,
    underscored: true,
    indexes: [
      {
        unique: true,
        fields: ['candidate_id', 'job_id'],
      },
    ],
  }
);
