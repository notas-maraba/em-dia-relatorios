# Em dia — Relatórios mensais

Aplicativo em português para acompanhar relatórios mensais, cadastrar publicadores e períodos de pioneiro, e gerar PDFs mensais e anuais.

A versão 4 usa Supabase Auth e um banco privado organizado por grupos e três perfis. O site público mostra somente o login. O administrador gerencia todos os grupos e usuários. O superintendente administra apenas seu grupo. O publicador consulta somente seu cartão e seus relatórios. Não há autoautorização nem catálogo público de grupos.

Ao entrar, o responsável vê o checklist do grupo vinculado à conta; o publicador vê Meu cartão. O vínculo também define o grupo inicial de uma conta administradora. Somente a administração pode consultar outro grupo pelo seletor no topo; essa consulta não altera o grupo padrão. Cada grupo possui base e revisão próprias. Dois superintendentes vinculados ao mesmo grupo administram a mesma lista.

O primeiro relatório enviado pelo publicador é recebido automaticamente. Se mudar um relatório já recebido, o reenvio aguarda decisão em Revisões: o responsável compara o recebido com a proposta e aceita ou ignora. Até a aceitação, o relatório recebido permanece válido. Cada envio e decisão verifica a versão para evitar que uma resposta atrasada sobrescreva outra edição. Participação, horas e estudos são os únicos campos enviados pelo publicador; a condição de pioneiro vem do cadastro e do histórico administrado pelo responsável.

Nos meses de pioneiro regular ou auxiliar, Meu cartão também oferece um diário de horas. O publicador registra horas e minutos em cada dia, edita os lançamentos e acompanha a soma do mês. Os lançamentos são salvos na nuvem e só aparecem para o acesso vinculado àquele cartão. Eles não são relatórios entregues e não alteram o total já recebido.

É possível salvar vários lançamentos na mesma data. Cada um aparece separado para editar ou excluir; o aplicativo soma os lançamentos da data e do mês. Um novo lançamento acrescenta horas. Editar ou excluir atua apenas no registro escolhido. Lançamentos acumulados e totais na mesma data podem ultrapassar 24 horas; o acumulado mensal pode ultrapassar a meta de 50 horas. O limite mensal suportado pelo relatório continua sendo 744 horas. Os registros anteriores são preservados.

Cada lançamento também oferece Observação (opcional). O texto fica privado no diário, pode ser editado ou apagado e não compõe o relatório mensal, a proposta de alteração ou os PDFs de relatórios. Alterar a observação não altera os minutos. Os registros anteriores aparecem com observação em branco; a atualização não inventa textos nem regrava esses registros.

O cronômetro permite iniciar, pausar, continuar e parar uma contagem. Seu estado fica na nuvem, vinculado ao cartão: fechar o aplicativo ou sair da conta não pausa nem reinicia a contagem. Ao reabrir com internet, o aplicativo consulta o estado salvo e calcula o tempo a partir dos horários do servidor, sem depender de um processo aberto em segundo plano. Há somente um cronômetro por cartão; iniciar exige o mês atual de pioneiro. Um cronômetro existente continua acessível após mudar de mês ou encerrar o período de pioneiro.

Ao parar, abre a conferência com o tempo exato e uma sugestão arredondada para o minuto mais próximo. É possível ajustar a data, as horas, os minutos e a observação antes de lançar. Fechar a conferência mantém o tempo parado para retomar depois. Lançar grava no diário e encerra o ciclo em uma única operação, protegida contra duplicação. Descartar exige confirmação. O cronômetro não salva lançamentos nem envia relatórios automaticamente; atingir a meta não interrompe a contagem.

Nos meses de pioneiro regular, o diário mostra o acompanhamento da meta mensal de 50 horas: horas registradas, progresso, quanto falta e média diária necessária até encerrar o mês. A média considera os dias restantes incluindo hoje e arredonda para cima em minutos. Atingir a meta mostra a conclusão e eventual excedente; meses encerrados não apresentam ritmo futuro. Um mês antigo sem lançamentos diários permanece sem cálculo de falta, mesmo quando há relatório mensal recebido. O painel usa somente os minutos do diário, sem somar novamente as horas do relatório.

As referências fornecidas para o pioneiro regular são 50 horas por mês e 600 horas por ano. Não há meta automática para pioneiro auxiliar. Essas referências orientam o acompanhamento pessoal e não impedem salvar ou enviar relatórios com outro total.

Para o pioneiro regular, Progresso anual acompanha o ano de serviço de 1º de setembro a 31 de agosto seguinte. O ciclo inicial acompanha o mês selecionado no cartão. A meta começa em 600 horas e pode ser ajustada para aquele cartão e ano, sem mudar a meta mensal. O painel mostra o total conhecido, quanto falta ou excedeu, meses sem informação e média necessária nos meses restantes. Não há ajuste proporcional automático da meta.

Cada mês entra uma única vez no progresso: primeiro o relatório regular recebido; na ausência dele, o diário regular; depois o histórico pessoal retroativo. Fontes, horas desconhecidas e zero explícito aparecem de forma distinta. Relatórios de publicador comum ou pioneiro auxiliar não compõem a meta anual de pioneiro regular. Um relatório aprovado com horas não informadas continua sem total conhecido, sem completar a lacuna com outra fonte.

O histórico pessoal permite cadastrar horas, minutos e estudos de meses encerrados, inclusive anteriores ao início do acompanhamento no sistema. Esse cadastro não altera os períodos do cartão, não inventa lançamentos diários e não envia relatórios ao superintendente. Meses com relatório recebido ou diário não podem ser substituídos pelo histórico; se uma fonte posterior passar a valer, o histórico anterior permanece guardado sem somar duas vezes. A meta e o histórico ficam privados na nuvem e acompanham a transferência do cartão.

No acesso de publicador, o aviãozinho Enviar no centro da navegação usa o mês selecionado. É possível conferir e enviar pelo sistema, seguindo a aprovação existente, ou preparar um texto para WhatsApp. O compartilhamento apresenta uma prévia com nome, mês, horas/minutos e estudos para pioneiros, ou participação e estudos para publicadores comuns. O usuário escolhe o destinatário e confirma no WhatsApp. Abrir ou copiar o texto não marca o relatório como recebido e não envia observações privadas do diário.

O publicador pode conferir a soma, informar os estudos bíblicos e enviar o relatório durante o mês em andamento ou depois de encerrado. Isso vale para pioneiros regulares e auxiliares, usando o total do diário ou o preenchimento manual. O banco calcula o total a partir dos minutos salvos, conferindo as versões do diário e do relatório. A conversão para o relatório usa horas decimais com duas casas; por exemplo, 1h30 corresponde a 1,5h. O primeiro envio entra como recebido e os reenvios seguem a aprovação pelo responsável. A opção manual não modifica o diário. Totais recebidos antes da criação do diário não são distribuídos em dias automaticamente.

Enviar durante o mês não encerra nem trava o diário ou o cronômetro. Novos lançamentos continuam disponíveis; para atualizar o relatório já recebido, confira e reenvie o novo total. O progresso anual continua usando o relatório aprovado quando ele existe, até uma nova alteração ser aceita. Meses futuros permanecem indisponíveis para envio, e o cadastro retroativo pessoal continua restrito a meses encerrados.

Em Publicadores → Editar, o administrador ou superintendente pode criar um acesso de publicador para aquele cartão ou transferir o cartão para outro grupo. A transferência leva o cadastro, o histórico, as revisões e o vínculo de login em uma única operação. O destinatário é escolhido em uma lista de nomes de grupos, sem acesso aos seus publicadores.

Na aba Publicadores, o botão Anual em cada cartão abre o relatório individual do ano correspondente ao mês de referência. O histórico exibe os 12 meses, o tipo de publicador ou pioneiro, a entrega, a participação, as horas e os estudos informados. O ano e o período podem ser ajustados; a mesma consulta pode ser exportada em PDF ou texto. Relatório pendente, participação não informada e mês sem acompanhamento permanecem distintos de uma participação marcada como Não.

Cada gravação compara a revisão esperada com a atual. Conflitos entre aparelhos exigem recarregar a base. Falhas de salvamento não são apresentadas como sucesso. A troca de grupo limpa a base anterior da interface antes de carregar a seguinte. Os relatórios ficam na memória da página e no banco; apenas a sessão de login é persistida pelo SDK.

Dados da versão local anterior não são importados nem apagados silenciosamente. Exporte essa base e confira antes de substituir a base na nuvem. Importar um backup substitui os registros do grupo selecionado, sem mesclar. Mantenha backups JSON e PDFs em um lugar privado fora deste repositório.

O backup JSON do grupo contém os cadastros e relatórios recebidos, sem os diários privados dos publicadores. Os diários permanecem no banco e acompanham a transferência do cartão; não são incluídos no arquivo público nem no cache de instalação. Preserve também cópias privadas do banco por uma administração confiável.

O site funciona no GitHub Pages, branch main, pasta / (root), com .nojekyll. Não há compilação. O SDK Supabase está incluído em assets/vendor, com versão exata, licença e dependências fixadas no lockfile.

A versão 3.1 mantém a apresentação de celular em todas as telas: cartões em duas colunas, listas em uma coluna, navegação inferior e formulários em painel inferior. Grupos, usuários e regras de acesso permanecem disponíveis.

Em Dados, na tela de entrada ou em Ajuda, use “Instalar no celular”. Navegadores compatíveis mostram a confirmação de instalação; no iPhone, siga as instruções para adicionar pelo Safari à Tela de Início. A instalação continua exigindo login e internet para consultar ou salvar relatórios. O serviço de cache guarda somente uma lista explícita de arquivos públicos do aplicativo, sem respostas de autenticação, contas, relatórios, backups ou consultas do Supabase.

assets/config.js contém somente URL, chave pública publishable e retorno de login. Senhas, chaves secretas, e-mails, IDs reais e backups não pertencem ao código público. supabase/schema.sql documenta a estrutura inicial, supabase/groups-upgrade.sql adapta uma instalação existente por grupos e supabase/migrations/ contém a evolução dos perfis, sem identidades pessoais.

A aba Usuários é exclusiva da administração. Nela, cadastre administradores e superintendentes, escolhendo um grupo existente ou criando um novo. O acesso de publicador é criado pelo cartão correspondente. Mudar o grupo de um responsável não move os publicadores; para mudar um publicador, use a transferência do cartão. O comando Gerenciar grupos no topo permite criar grupos. A função de servidor em-dia-users verifica a sessão e a permissão necessária antes de usar a API privada de autenticação. Chaves de servidor ficam somente nas variáveis protegidas do Supabase.

Com Node.js 22 ou posterior:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Leia também [PRIVACIDADE.md](PRIVACIDADE.md), [PUBLICAR.md](PUBLICAR.md) e [TESTES.md](TESTES.md).
