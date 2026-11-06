# Privacidade e acesso

O código é público. Cadastros, relatórios, observações e backups não integram o repositório nem arquivos públicos de inicialização.

Supabase Auth verifica o login. Perfis e vínculos mantidos no banco determinam a autorização; metadados editáveis pelo usuário não concedem privilégios. Administradores gerenciam todos os grupos e usuários. Superintendentes administram somente seu grupo. Publicadores recebem apenas o próprio cartão e os próprios relatórios por uma função específica, sem observações internas nem a base completa do grupo. Visitantes e contas não autorizadas não recebem os registros. Não basta alterar um identificador no navegador para ampliar o acesso. O navegador não pode escrever diretamente nas tabelas nem atribuir a si mesmo outro perfil ou grupo.

O primeiro envio de atividade do publicador é recebido automaticamente. Alterações posteriores aguardam decisão do responsável; a proposta não substitui o relatório recebido antes da aceitação. Envio, decisão e transferência conferem versões e permissões no banco. A transferência de cartão move seu histórico e seu vínculo de login juntos; o publicador passa a ver apenas esse cartão no grupo de destino.

O diário de horas dos meses de pioneiro é separado dos relatórios recebidos. Somente o publicador vinculado ao cartão consulta e edita seus lançamentos diários pelas funções autorizadas. Administradores e superintendentes recebem o total mensal enviado, sem consulta ao diário por esse acesso. Trocar o login vinculado preserva o diário do cartão; transferir o cartão move o diário junto. Os registros não são gravados no JSON da base do grupo, no cache do aplicativo ou no repositório.

Vários lançamentos na mesma data permanecem como registros separados. A soma por dia e por mês é conferida no banco. Cada edição ou exclusão exige o acesso vinculado ao cartão e a versão atual do diário. Repetir a mesma requisição identificada não acrescenta outro registro. Clientes antigos não podem substituir silenciosamente um dia que já tenha vários lançamentos.

A observação opcional pertence ao lançamento privado e fica disponível apenas ao publicador vinculado ao cartão. O envio mensal leva os totais de atividade, sem a observação. O texto é exibido como texto, sem executar marcação ou scripts. Clientes antigos preservam a observação quando alteram somente as horas de um registro. As cópias privadas do banco devem proteger esses textos junto com o restante do diário.

O cronômetro também é privado do cartão. Estado, horários e recibo do último lançamento ficam em tabela privada, sem acesso direto por navegador, administrador ou superintendente. As funções conferem a conta e o vínculo no servidor. A transferência do cartão leva o cronômetro; trocar o login não o reinicia. Não há cópia do cronômetro em localStorage ou no cache de instalação. Sair da conta limpa sua exibição, sem parar uma contagem na nuvem. Inclua essa tabela nas cópias privadas do banco; o backup JSON do grupo não a contém.

A meta anual e os meses retroativos pertencem ao acompanhamento privado do cartão. Somente seu acesso de publicador pode consultá-los e alterá-los pelas funções próprias. Eles não entram na base JSON do grupo nem no backup exportado pelo responsável, não alteram relatórios recebidos e não são enviados automaticamente. A transferência e a troca de login preservam esses dados. Inclua annual_progress nas cópias privadas do banco; o cache de instalação continua contendo somente arquivos públicos.

O texto para WhatsApp inclui somente os campos apresentados na conferência. Abrir o WhatsApp é uma ação explícita do usuário, que escolhe o destinatário e confirma o envio naquele aplicativo. Não são incluídas observações privadas, histórico do cronômetro, credenciais ou a base do grupo. Preparar, copiar ou abrir esse texto não grava um envio no sistema.

Salvar um lançamento não envia o relatório. O envio pode ocorrer no mês corrente ou em mês anterior e usa a soma calculada no banco, com controle de versões para evitar totais desatualizados. O usuário confirma o envio; não há atualização automática do recebido quando novos dias são lançados. Alterações de um relatório recebido continuam aguardando decisão do responsável. Remover um lançamento diário não remove um relatório recebido. O backup JSON do grupo não contém o diário privado; sua cópia de segurança exige uma exportação privada do banco por administração confiável.

A chave publishable e a URL são identificadores públicos. Não dão acesso aos dados por si só. Nunca publique senha, chave secreta ou service_role.

A comunicação usa HTTPS. O SDK persiste a sessão do usuário no navegador. Use aparelhos confiáveis e saia da conta em aparelhos compartilhados. Sair remove os dados da interface; proteja separadamente arquivos JSON e PDF já baixados.

Em conflito ou falha de rede, confira o estado remoto antes de repetir uma gravação: uma requisição pode ter sido aceita antes da conexão cair. Não há mesclagem automática de duas edições.

Importar substitui somente a base do grupo selecionado. Preserve um backup anterior e confira qual grupo está aberto antes de confirmar. A transferência de um responsável para outro grupo muda seu acesso e não move nem apaga os publicadores do grupo anterior. O aplicativo não apaga nem importa automaticamente o armazenamento da versão local antiga. O plano Free pode ter pausas e limites; mantenha backups privados externos.

O cadastro de usuários é realizado por uma função de servidor. Somente administradores criam administradores ou superintendentes. O responsável de um grupo pode criar um acesso de publicador para um cartão daquele grupo. A função verifica o destino antes de criar a conta. Senhas vão diretamente ao serviço de autenticação, não integram relatórios, backups ou arquivos públicos. Uma conta criada sem concluir seu vínculo não recebe acesso ao aplicativo. Em caso de falha parcial, a administração deve concluir o vínculo; não repita uma criação automaticamente nem altere a senha de uma conta existente.

Referências: [segurança](https://supabase.com/docs/guides/database/secure-data), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [sessões](https://supabase.com/docs/guides/auth/sessions).
