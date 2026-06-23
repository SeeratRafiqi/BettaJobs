import { DataTypes, Model } from 'sequelize';
import sequelize from '../config.js';
import { BaseModel } from '../base/BaseModel.js';

export type CvStatus = 'uploaded' | 'parsing' | 'matrix_ready' | 'failed' | 'needs_review';

export interface CvFileAttributes {
  id: string;
  candidate_id: string;
  filename: string;
  file_path: string;
  file_size: number;
  status: CvStatus;
  batch_tag?: string;
  /** Set when a company org bulk-uploaded the CV; null for candidate self-uploads. */
  source_company_id?: string | null;
  label?: string;
  is_primary?: boolean;
  uploaded_at?: Date;
  processed_at?: Date;
}

export class CvFile extends BaseModel<CvFileAttributes> implements CvFileAttributes {
  declare id: string;
  declare candidate_id: string;
  declare filename: string;
  declare file_path: string;
  declare file_size: number;
  declare status: CvStatus;
  declare batch_tag?: string;
  declare source_company_id: string | null;
  declare label?: string;
  declare is_primary: boolean;
  declare uploaded_at: Date;
  declare processed_at?: Date;
}

CvFile.init(
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
    filename: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    file_path: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },
    file_size: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('uploaded', 'parsing', 'matrix_ready', 'failed', 'needs_review'),
      allowNull: false,
      defaultValue: 'uploaded',
    },
    batch_tag: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    source_company_id: {
      type: DataTypes.STRING(36),
      allowNull: true,
      references: {
        model: 'company_profiles',
        key: 'id',
      },
    },
    label: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    is_primary: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    uploaded_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    processed_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'cv_files',
    timestamps: false,
    underscored: true,
  }
);
